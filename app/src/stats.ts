/**
 * Stats: scans Claude Code transcript roots and aggregates helper
 * (sub-agent) activity, tool calls, tokens and API-equivalent cost.
 *
 * Layout read: <root>/<job>/<session>.jsonl (main agent) and
 * <root>/<job>/<session>/subagents/agent-*.jsonl (helpers). A "job" is the
 * project directory (encoded cwd). Read-only; never writes to the roots.
 * Costs are API-equivalent estimates (Max-plan work is not billed per token).
 *
 * computeStats() below parses every file synchronously on every call — fine
 * for small transcript dirs, but it blocks the event loop and loads whole
 * files into memory on dirs with hundreds of large files. stats-watcher.ts
 * uses the lower-level newAccumulator/addLine/discoverTranscriptFiles/
 * aggregateStats pieces exported here to build the same shape incrementally
 * in the background instead. computeStats/parseTranscript stay as simple,
 * synchronous wrappers around those pieces for tests and one-off use.
 */
import * as fs from 'fs'
import * as path from 'path'
import defaultPricing from '../../config/pricing.json'

export interface Rate { input: number; output: number; cacheRead: number; cacheWrite: number }
export interface PriceTable { models: Record<string, Rate>; default: Rate }
export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number }

export const COST_LABEL = 'API-equivalent estimate (Max plan: not billed)'

export function loadPricing(file = process.env.AGENT_FLOW_PRICING): PriceTable {
  if (!file) return defaultPricing as PriceTable
  return JSON.parse(fs.readFileSync(file, 'utf8')) as PriceTable
}

export function rateFor(model: string, table: PriceTable): Rate {
  let best: string | undefined
  for (const key of Object.keys(table.models)) {
    if (model.toLowerCase().includes(key.toLowerCase()) && (!best || key.length > best.length)) best = key
  }
  return best ? table.models[best] : table.default
}

/** Cost in USD for a usage record at per-million-token rates. */
export function costOf(u: Usage, rate: Rate): number {
  return (u.input * rate.input + u.output * rate.output + u.cacheRead * rate.cacheRead + u.cacheWrite * rate.cacheWrite) / 1e6
}

export function modelFamily(model: string): string {
  const m = model.toLowerCase()
  for (const f of ['opus', 'sonnet', 'haiku']) if (m.includes(f)) return f
  return 'other'
}

interface Bucket { helpers: number; toolCalls: number; tokens: number; cost: number }
const emptyBucket = (): Bucket => ({ helpers: 0, toolCalls: 0, tokens: 0, cost: 0 })

export interface HelperStat {
  job: string
  id: string
  model: string
  running: boolean
  toolCalls: number
  usage: Usage
  tokens: number
  cost: number
  lastActivity: string
}

type DayBucket = { toolCalls: number; usage: Usage; cost: number }

/** Running parse state for one transcript file — carried across incremental
 *  reads so a background watcher can feed it only the newly-appended lines. */
export interface TranscriptAccumulator {
  seen: Set<string>
  model: string
  toolCalls: number
  usage: Usage
  cost: number
  days: Record<string, DayBucket>
  last: string
}

export function newAccumulator(): TranscriptAccumulator {
  return { seen: new Set(), model: '', toolCalls: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, days: {}, last: '' }
}

/** Fold one transcript line into an accumulator (deduped by message id). Skips
 *  non-assistant, partial/corrupt and blank lines. Safe to call repeatedly
 *  with consecutive slices of the same file — dedup state persists in `acc`. */
export function addLine(acc: TranscriptAccumulator, line: string, table: PriceTable): void {
  if (!line.trim()) return
  let e: any
  try { e = JSON.parse(line) } catch { return } // partial/corrupt line
  if (e?.type !== 'assistant' || !e.message) return
  const m = e.message
  const key = m.id ? `${m.id}:${e.requestId ?? ''}` : ''
  if (key && acc.seen.has(key)) return
  if (key) acc.seen.add(key)
  const mdl = typeof m.model === 'string' && !m.model.startsWith('<') ? m.model : ''
  if (mdl) acc.model = mdl
  const u = m.usage ?? {}
  const rec: Usage = {
    input: Number(u.input_tokens) || 0,
    output: Number(u.output_tokens) || 0,
    cacheRead: Number(u.cache_read_input_tokens) || 0,
    cacheWrite: Number(u.cache_creation_input_tokens) || 0,
  }
  const tools = Array.isArray(m.content) ? m.content.filter((c: any) => c?.type === 'tool_use').length : 0
  const c = costOf(rec, rateFor(mdl || acc.model, table))
  acc.toolCalls += tools; acc.cost += c
  acc.usage.input += rec.input; acc.usage.output += rec.output; acc.usage.cacheRead += rec.cacheRead; acc.usage.cacheWrite += rec.cacheWrite
  const ts = typeof e.timestamp === 'string' ? e.timestamp : ''
  if (ts > acc.last) acc.last = ts
  const day = ts.slice(0, 10) || 'unknown'
  const d = (acc.days[day] ??= { toolCalls: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 })
  d.toolCalls += tools; d.cost += c
  d.usage.input += rec.input; d.usage.output += rec.output; d.usage.cacheRead += rec.cacheRead; d.usage.cacheWrite += rec.cacheWrite
}

export interface ParsedTranscript { model: string; toolCalls: number; usage: Usage; cost: number; days: Record<string, DayBucket>; last: string }

/** Snapshot an accumulator's running totals into the shape AggregateEntry.parsed expects. */
export function toParsedTranscript(acc: TranscriptAccumulator): ParsedTranscript {
  return { model: acc.model, toolCalls: acc.toolCalls, usage: acc.usage, cost: acc.cost, days: acc.days, last: acc.last }
}

/** Parse one transcript file's full text into per-call records (deduped by message id). */
export function parseTranscript(text: string, table: PriceTable): ParsedTranscript {
  const acc = newAccumulator()
  for (const line of text.split('\n')) addLine(acc, line, table)
  return toParsedTranscript(acc)
}

const sumTokens = (u: Usage) => u.input + u.output + u.cacheRead + u.cacheWrite

function listJsonl(dir: string): string[] {
  try { return fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => path.join(dir, f)) } catch { return [] }
}

export interface DiscoveredFile { file: string; helper: boolean; job: string }

/** Walk `<root>/<job>/*.jsonl` (main) and `<root>/<job>/<session>/subagents/*.jsonl`
 *  (helpers) across every root. Listing only — no stat/read, so this is cheap
 *  even on directories with hundreds of transcripts. */
export function discoverTranscriptFiles(roots: string[]): DiscoveredFile[] {
  const out: DiscoveredFile[] = []
  for (const root of roots) {
    let jobs: string[] = []
    try { jobs = fs.readdirSync(root) } catch { continue }
    for (const job of jobs) {
      const jobDir = path.join(root, job)
      for (const f of listJsonl(jobDir)) out.push({ file: f, helper: false, job })
      let sessions: string[] = []
      try { sessions = fs.readdirSync(jobDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) } catch { /* none */ }
      for (const s of sessions) for (const f of listJsonl(path.join(jobDir, s, 'subagents'))) out.push({ file: f, helper: true, job })
    }
  }
  return out
}

export interface AggregateEntry { file: string; helper: boolean; job: string; mtimeMs: number; parsed: ParsedTranscript }
export interface AggregateOptions {
  now: number
  /** Window in days (by day-bucket cutoff; file-level inclusion is the caller's job). Default 7. */
  windowDays?: number
  /** A helper counts as running if its transcript changed within this many ms. Default 120_000. */
  runMs?: number
}

/** Build the computeStats() response shape from already-parsed per-file
 *  entries. Pure in-memory aggregation (no file I/O) — cheap enough to run
 *  on every request, which is what lets a cached-entry snapshot stay fresh
 *  without re-parsing anything. */
export function aggregateStats(entries: AggregateEntry[], opts: AggregateOptions) {
  const now = opts.now
  const windowDays = opts.windowDays ?? 7
  const runMs = opts.runMs ?? 120_000
  const cutoff = now - windowDays * 86400_000
  const cutoffDay = new Date(cutoff).toISOString().slice(0, 10)
  const today = new Date(now).toISOString().slice(0, 10)

  const helpers: HelperStat[] = []
  const byModel: Record<string, Bucket> = {}
  const byJob: Record<string, Bucket & { running: number; byModel: Record<string, number> }> = {}
  const byDay: Record<string, Bucket> = {}

  for (const { file, helper, job, mtimeMs, parsed: p } of entries) {
    const fam = modelFamily(p.model || 'unknown')
    const running = helper && now - mtimeMs <= runMs
    const j = (byJob[job] ??= { ...emptyBucket(), running: 0, byModel: {} })
    // Per-day cost/tool/token totals include main + helper activity within the window.
    for (const [day, d] of Object.entries(p.days)) {
      if (day < cutoffDay) continue
      const b = (byDay[day] ??= emptyBucket())
      b.toolCalls += d.toolCalls; b.tokens += sumTokens(d.usage); b.cost += d.cost
    }
    const tokens = sumTokens(p.usage)
    j.toolCalls += p.toolCalls; j.tokens += tokens; j.cost += p.cost
    j.byModel[fam] = (j.byModel[fam] ?? 0) + p.cost
    const bm = (byModel[fam] ??= emptyBucket())
    bm.toolCalls += p.toolCalls; bm.tokens += tokens; bm.cost += p.cost
    if (helper) {
      j.helpers++; bm.helpers++
      if (running) j.running++
      helpers.push({ job, id: path.basename(file, '.jsonl'), model: p.model, running, toolCalls: p.toolCalls, usage: p.usage, tokens, cost: p.cost, lastActivity: p.last })
    }
  }

  const round = (n: number) => Math.round(n * 1e4) / 1e4
  const running = helpers.filter(h => h.running)
  const runningByModel: Record<string, number> = {}
  for (const h of running) { const f = modelFamily(h.model || 'unknown'); runningByModel[f] = (runningByModel[f] ?? 0) + 1 }
  const todayB = byDay[today] ?? emptyBucket()
  const total = Object.values(byModel).reduce((a, b) => ({ helpers: a.helpers + b.helpers, toolCalls: a.toolCalls + b.toolCalls, tokens: a.tokens + b.tokens, cost: a.cost + b.cost }), emptyBucket())

  return {
    costLabel: COST_LABEL,
    generatedAt: new Date(now).toISOString(),
    windowDays,
    running: { helpers: running.length, byModel: runningByModel, jobs: [...new Set(running.map(h => h.job))] },
    today: { day: today, toolCalls: todayB.toolCalls, tokens: todayB.tokens, costUsd: round(todayB.cost) },
    total: { helpers: total.helpers, toolCalls: total.toolCalls, tokens: total.tokens, costUsd: round(total.cost) },
    byModel: Object.fromEntries(Object.entries(byModel).map(([k, v]) => [k, { ...v, cost: undefined, costUsd: round(v.cost) }])),
    byJob: Object.fromEntries(Object.entries(byJob).map(([k, v]) => [k, {
      helpers: v.helpers, running: v.running, toolCalls: v.toolCalls, tokens: v.tokens, costUsd: round(v.cost),
      costUsdByModel: Object.fromEntries(Object.entries(v.byModel).map(([m, c]) => [m, round(c)])),
    }])),
    byDay: Object.fromEntries(Object.entries(byDay).sort().map(([k, v]) => [k, { toolCalls: v.toolCalls, tokens: v.tokens, costUsd: round(v.cost) }])),
    helpers: helpers.map(h => ({ ...h, cost: undefined, costUsd: round(h.cost) })),
  }
}

export interface StatsOptions {
  roots: string[]
  table?: PriceTable
  now?: number
  /** Window in days (by file mtime and per-day bucket). Default 7. */
  days?: number
  /** A helper counts as running if its transcript changed within this many seconds. Default 120. */
  runningSeconds?: number
}

/** Synchronous, blocking stats computation — reads and parses every transcript
 *  file on every call. Fine for tests/small dirs; the live HTTP server uses
 *  the background stats-watcher instead so requests never block on disk I/O. */
export function computeStats(opts: StatsOptions) {
  const table = opts.table ?? loadPricing()
  const now = opts.now ?? Date.now()
  const windowDays = opts.days ?? 7
  const runMs = (opts.runningSeconds ?? 120) * 1000
  const cutoff = now - windowDays * 86400_000

  const entries: AggregateEntry[] = []
  for (const { file, helper, job } of discoverTranscriptFiles(opts.roots)) {
    let st: fs.Stats
    try { st = fs.statSync(file) } catch { continue }
    if (st.mtimeMs < cutoff) continue
    let text: string
    try { text = fs.readFileSync(file, 'utf8') } catch { continue }
    entries.push({ file, helper, job, mtimeMs: st.mtimeMs, parsed: parseTranscript(text, table) })
  }
  return aggregateStats(entries, { now, windowDays, runMs })
}

/** Flat key/value form for Home Assistant REST sensors. */
export function flattenStats(s: ReturnType<typeof computeStats>) {
  return {
    helpers_running: s.running.helpers,
    helpers_running_opus: s.running.byModel.opus ?? 0,
    helpers_running_sonnet: s.running.byModel.sonnet ?? 0,
    helpers_running_haiku: s.running.byModel.haiku ?? 0,
    jobs_running: s.running.jobs.length,
    tool_calls_today: s.today.toolCalls,
    tokens_today: s.today.tokens,
    cost_today_usd: s.today.costUsd,
    cost_window_usd: s.total.costUsd,
    window_days: s.windowDays,
    cost_label: s.costLabel,
    generated_at: s.generatedAt,
  }
}
