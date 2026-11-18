/**
 * Background, incremental stats builder.
 *
 * computeStats() in stats.ts re-reads and re-parses every transcript file on
 * every call — fine for tests/small dirs, but on a dir with hundreds of
 * multi-MB files it blocks the event loop for tens of seconds and loads
 * whole files into memory per request. This module instead:
 *
 *   - polls transcript roots on an interval (not fs.watch — a dir with
 *     hundreds of session/subagent files risks hitting OS watch-handle
 *     limits; a stat() pass over every file is cheap, it's re-reading file
 *     *contents* we need to avoid)
 *   - tracks a byte offset + a running TranscriptAccumulator per file
 *   - skips any file whose mtime hasn't advanced since it was last fully
 *     read, and skips files untouched within the configured window
 *     entirely (dropping their cached state, so memory doesn't grow with
 *     the full history of a long-lived transcript root)
 *   - for files with new bytes, streams only the new byte range in bounded
 *     chunks (CHUNK_BYTES), never materializing a whole file — or even a
 *     whole multi-GB delta — in memory at once
 *   - rebuilds the served snapshot by re-running stats.ts's aggregateStats()
 *     over the cached per-file accumulators — pure in-memory arithmetic, no
 *     disk I/O, cheap even across thousands of files
 *
 * getSnapshot() always returns instantly from memory. Before the first full
 * pass over every discovered file completes, it reports `warmingUp: true`.
 */
import * as fs from 'fs'
import { open as openFile } from 'fs/promises'
import { StringDecoder } from 'string_decoder'
import {
  PriceTable, loadPricing, newAccumulator, addLine, toParsedTranscript, TranscriptAccumulator,
  discoverTranscriptFiles, aggregateStats, AggregateEntry,
} from './stats'

const DAY_MS = 86400_000

/** Bounds memory per read regardless of file or delta size. */
const CHUNK_BYTES = 4 * 1024 * 1024

export interface WatcherFileState {
  offset: number
  mtimeMs: number
  helper: boolean
  job: string
  acc: TranscriptAccumulator
  /** Bytes past the last complete newline from the previous read, carried
   *  forward so a line split across two polls isn't lost or double-counted. */
  tail: string
}

export interface WatcherState {
  files: Map<string, WatcherFileState>
  table: PriceTable
  /** Files not modified within this many days are skipped (and evicted from cache). */
  windowDays: number
  /** Number of full discovery passes completed — 0 means still warming up. */
  passesCompleted: number
}

export function createWatcherState(opts: { table?: PriceTable; windowDays?: number }): WatcherState {
  return {
    files: new Map(),
    table: opts.table ?? loadPricing(),
    windowDays: opts.windowDays ?? 7,
    passesCompleted: 0,
  }
}

/** Stream-read `[entry.offset, newSize)` from `filePath` in bounded chunks,
 *  folding each complete line into `entry.acc`. Never reads more than
 *  CHUNK_BYTES into memory at once, so this is safe for multi-GB deltas. */
async function tailFile(filePath: string, entry: WatcherFileState, newSize: number, table: PriceTable): Promise<void> {
  const fd = await openFile(filePath, 'r')
  try {
    const decoder = new StringDecoder('utf8')
    let pos = entry.offset
    let carry = entry.tail
    while (pos < newSize) {
      const len = Math.min(CHUNK_BYTES, newSize - pos)
      const buf = Buffer.alloc(len)
      const { bytesRead } = await fd.read(buf, 0, len, pos)
      if (bytesRead <= 0) break
      const text = carry + decoder.write(buf.subarray(0, bytesRead))
      const parts = text.split(/\r?\n/)
      carry = parts.pop() ?? ''
      for (const line of parts) addLine(entry.acc, line, table)
      pos += bytesRead
    }
    entry.tail = carry + decoder.end()
    entry.offset = pos
  } finally {
    await fd.close()
  }
}

/** One discovery + incremental-read pass over every root. Safe to call
 *  directly in tests; createStatsWatcher() just schedules this on a timer. */
export async function scanOnce(state: WatcherState, roots: string[]): Promise<void> {
  const now = Date.now()
  const cutoff = now - state.windowDays * DAY_MS
  const discovered = discoverTranscriptFiles(roots)
  const seen = new Set<string>()

  for (const { file, helper, job } of discovered) {
    seen.add(file)
    let st: fs.Stats
    try { st = fs.statSync(file) } catch { continue } // removed between discovery and stat

    if (st.mtimeMs < cutoff) {
      state.files.delete(file) // outside window — drop any cached state to bound memory
      continue
    }

    let entry = state.files.get(file)
    if (!entry) {
      entry = { offset: 0, mtimeMs: 0, helper, job, acc: newAccumulator(), tail: '' }
      state.files.set(file, entry)
    }
    if (st.size < entry.offset) {
      // Truncated or rotated out from under us — start over.
      entry.offset = 0; entry.mtimeMs = 0; entry.acc = newAccumulator(); entry.tail = ''
    }
    if (st.mtimeMs === entry.mtimeMs && st.size === entry.offset) continue // nothing new

    try {
      await tailFile(file, entry, st.size, state.table)
      entry.mtimeMs = st.mtimeMs
    } catch {
      // Transient I/O error or the file disappeared mid-read — retry next pass.
    }
  }

  // Drop files that no longer exist (removed, or a session directory that moved).
  for (const file of state.files.keys()) if (!seen.has(file)) state.files.delete(file)

  state.passesCompleted++
}

export interface Snapshot { stats: ReturnType<typeof aggregateStats>; warmingUp: boolean }

/** Build the computeStats()-shaped response from cached per-file state — pure
 *  in-memory aggregation, no file I/O. `days` is clamped to `state.windowDays`:
 *  the cache never holds data for files older than that, so a request for a
 *  wider window can't be honored without re-reading disk (which is exactly
 *  what this module exists to avoid). */
export function snapshotFromState(state: WatcherState, days?: number, runningSeconds = 120): Snapshot {
  const now = Date.now()
  const windowDays = Math.min(state.windowDays, Math.max(1, days ?? 7))
  const cutoff = now - windowDays * DAY_MS

  const entries: AggregateEntry[] = []
  for (const [file, entry] of state.files) {
    if (entry.mtimeMs < cutoff) continue
    entries.push({ file, helper: entry.helper, job: entry.job, mtimeMs: entry.mtimeMs, parsed: toParsedTranscript(entry.acc) })
  }
  const stats = aggregateStats(entries, { now, windowDays, runMs: runningSeconds * 1000 })
  return { stats, warmingUp: state.passesCompleted === 0 }
}

export interface StatsWatcherOptions {
  roots: string[]
  table?: PriceTable
  /** Files not modified within this many days are skipped. Default 7, or
   *  AGENT_FLOW_STATS_WINDOW_DAYS when set. */
  windowDays?: number
  /** Poll interval between scans, ms. Default 30s, or AGENT_FLOW_STATS_INTERVAL_MS. */
  intervalMs?: number
  /** A helper counts as running if its transcript changed within this many seconds. Default 120. */
  runningSeconds?: number
}

export interface StatsWatcher {
  /** Instant, in-memory read — never touches disk. */
  getSnapshot(days?: number): Snapshot
  /** Number of transcript files currently cached (for diagnostics/tests). */
  fileCount(): number
  stop(): void
}

function resolveWindowDays(opts: StatsWatcherOptions): number {
  if (opts.windowDays !== undefined) return opts.windowDays
  const env = Number(process.env.AGENT_FLOW_STATS_WINDOW_DAYS)
  return Number.isFinite(env) && env > 0 ? env : 7
}

function resolveIntervalMs(opts: StatsWatcherOptions): number {
  if (opts.intervalMs !== undefined) return opts.intervalMs
  const env = Number(process.env.AGENT_FLOW_STATS_INTERVAL_MS)
  return Number.isFinite(env) && env > 0 ? env : 30_000
}

export function createStatsWatcher(opts: StatsWatcherOptions): StatsWatcher {
  const state = createWatcherState({ table: opts.table, windowDays: resolveWindowDays(opts) })
  const runningSeconds = opts.runningSeconds ?? 120
  let scanning = false
  let stopped = false

  async function tick() {
    if (scanning || stopped) return
    scanning = true
    try { await scanOnce(state, opts.roots) }
    catch { /* best-effort — next tick retries */ }
    finally { scanning = false }
  }

  void tick() // kick off the first pass immediately; server startup doesn't wait on it
  const interval = setInterval(tick, resolveIntervalMs(opts))
  interval.unref?.() // don't keep the process alive solely for this timer

  return {
    getSnapshot: (days?: number) => snapshotFromState(state, days, runningSeconds),
    fileCount: () => state.files.size,
    stop() { stopped = true; clearInterval(interval) },
  }
}
