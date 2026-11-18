import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createWatcherState, scanOnce, snapshotFromState, createStatsWatcher, WatcherState } from './stats-watcher'
import { loadPricing } from './stats'

const table = loadPricing(undefined)
const NOW = Date.parse('2026-11-17T12:00:00Z')

function line(id: string, model: string, usage: object, tools: number, ts: string) {
  return JSON.stringify({ type: 'assistant', timestamp: ts, requestId: 'r' + id, message: { id, model, usage, content: Array.from({ length: tools }, () => ({ type: 'tool_use' })) } })
}

test('warmingUp lifecycle: starts true, becomes false after scanOnce', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-watcher-'))
  const job = path.join(root, 'j1')
  fs.mkdirSync(job)
  fs.writeFileSync(path.join(job, 's.jsonl'), line('m1', 'claude-haiku-5-5', { input_tokens: 1000 }, 1, '2026-11-17T10:00:00Z') + '\n')
  const now = Date.now()
  fs.utimesSync(path.join(job, 's.jsonl'), now / 1000, now / 1000)

  const state = createWatcherState({ table, windowDays: 7 })
  assert.equal(state.passesCompleted, 0)

  const snap1 = snapshotFromState(state)
  assert.equal(snap1.warmingUp, true)

  await scanOnce(state, [root])
  assert.equal(state.passesCompleted, 1)

  const snap2 = snapshotFromState(state)
  assert.equal(snap2.warmingUp, false)
  assert.equal(snap2.stats.total.toolCalls, 1)
})

test('incremental re-read: append line, scanOnce twice, verify accumulation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-watcher-'))
  const job = path.join(root, 'j1')
  fs.mkdirSync(job)
  const transcript = path.join(job, 's.jsonl')
  const now = Date.now()

  // Write first line
  fs.writeFileSync(transcript, line('m1', 'claude-haiku-5-5', { input_tokens: 1000, output_tokens: 500 }, 2, '2026-11-17T10:00:00Z') + '\n')
  fs.utimesSync(transcript, now / 1000, now / 1000)

  const state = createWatcherState({ table, windowDays: 7 })
  await scanOnce(state, [root])
  const snap1 = snapshotFromState(state)
  assert.equal(snap1.stats.total.toolCalls, 2)

  // Append second line to same file
  const line2 = line('m2', 'claude-haiku-5-5', { input_tokens: 2000, output_tokens: 1000 }, 3, '2026-11-17T11:00:00Z')
  fs.appendFileSync(transcript, line2 + '\n')
  fs.utimesSync(transcript, (now + 10000) / 1000, (now + 10000) / 1000)

  await scanOnce(state, [root])
  const snap2 = snapshotFromState(state)
  assert.equal(snap2.stats.total.toolCalls, 5) // 2 + 3
})

test('skip stale files: file older than windowDays is excluded and evicted from cache', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-watcher-'))
  const job = path.join(root, 'j1')
  fs.mkdirSync(job)
  const transcript = path.join(job, 's.jsonl')
  const now = Date.now()

  fs.writeFileSync(transcript, line('m1', 'claude-haiku-5-5', { input_tokens: 1000 }, 1, '2026-11-17T10:00:00Z') + '\n')
  // Set mtime to 10 days old (outside 7-day window)
  fs.utimesSync(transcript, (now - 10 * 86400 * 1000) / 1000, (now - 10 * 86400 * 1000) / 1000)

  const state = createWatcherState({ table, windowDays: 7 })
  await scanOnce(state, [root])

  // File should be excluded from cache due to stale mtime
  assert.equal(state.files.has(transcript), false)
  assert.equal(state.files.size, 0)

  const snap = snapshotFromState(state)
  assert.equal(snap.stats.total.toolCalls, 0)
})

test('stale file eviction: previously cached file evicted when it goes stale', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-watcher-'))
  const job = path.join(root, 'j1')
  fs.mkdirSync(job)
  const transcript = path.join(job, 's.jsonl')
  const now = Date.now()

  fs.writeFileSync(transcript, line('m1', 'claude-haiku-5-5', { input_tokens: 1000 }, 1, '2026-11-17T10:00:00Z') + '\n')
  fs.utimesSync(transcript, (now - 1) / 1000, (now - 1) / 1000)

  const state = createWatcherState({ table, windowDays: 7 })

  // First scan: file is fresh, should be cached
  await scanOnce(state, [root])
  assert.equal(state.files.size, 1)

  // Set mtime to 10 days old
  fs.utimesSync(transcript, (now - 10 * 86400 * 1000) / 1000, (now - 10 * 86400 * 1000) / 1000)

  // Second scan: file is now stale, should be evicted
  await scanOnce(state, [root])
  assert.equal(state.files.has(transcript), false)
  assert.equal(state.files.size, 0)
})

test('helpers: subagent transcript in <job>/<session>/subagents/agent-*.jsonl shows up as running helper', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-watcher-'))
  const job = path.join(root, 'j1')
  const session = path.join(job, 's1')
  const subagents = path.join(session, 'subagents')
  fs.mkdirSync(subagents, { recursive: true })
  const now = Date.now()

  const helperFile = path.join(subagents, 'agent-helper1.jsonl')
  fs.writeFileSync(helperFile, line('h1', 'claude-sonnet-5-5', { output_tokens: 1_000_000 }, 2, '2026-11-17T11:59:00Z') + '\n')
  fs.utimesSync(helperFile, (now - 30 * 1000) / 1000, (now - 30 * 1000) / 1000)

  const state = createWatcherState({ table, windowDays: 7 })
  await scanOnce(state, [root])

  const snap = snapshotFromState(state, 7, 120)
  assert.equal(snap.stats.running.helpers, 1)
  assert.equal(snap.stats.total.helpers, 1)
  assert.ok(snap.stats.helpers.length > 0)
  const helper = snap.stats.helpers[0]
  assert.equal(helper.id, 'agent-helper1')
  assert.equal(helper.running, true)
  assert.equal(helper.toolCalls, 2)
})

test('helpers: old helper transcript not marked as running', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-watcher-'))
  const job = path.join(root, 'j1')
  const session = path.join(job, 's1')
  const subagents = path.join(session, 'subagents')
  fs.mkdirSync(subagents, { recursive: true })
  const now = Date.now()

  const helperFile = path.join(subagents, 'agent-old.jsonl')
  fs.writeFileSync(helperFile, line('h2', 'claude-haiku-5-5', { output_tokens: 1_000_000 }, 1, '2026-11-16T11:00:00Z') + '\n')
  fs.utimesSync(helperFile, (now - 3600 * 1000) / 1000, (now - 3600 * 1000) / 1000)

  const state = createWatcherState({ table, windowDays: 7 })
  await scanOnce(state, [root])

  const snap = snapshotFromState(state, 7, 120)
  assert.equal(snap.stats.running.helpers, 0)
  assert.equal(snap.stats.total.helpers, 1)
  const helper = snap.stats.helpers[0]
  assert.equal(helper.running, false)
})

test('createStatsWatcher smoke test: background interval ticks, getSnapshot works, stop cleans up', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-watcher-'))
  const job = path.join(root, 'j1')
  fs.mkdirSync(job)
  const now = Date.now()
  fs.writeFileSync(path.join(job, 's.jsonl'), line('m1', 'claude-haiku-5-5', { input_tokens: 1000 }, 1, '2026-11-17T10:00:00Z') + '\n')
  fs.utimesSync(path.join(job, 's.jsonl'), now / 1000, now / 1000)

  const watcher = createStatsWatcher({
    roots: [root],
    table,
    windowDays: 7,
    intervalMs: 50,
  })

  // Initial call: warming up
  const snap0 = watcher.getSnapshot()
  assert.equal(snap0.warmingUp, true)

  // Wait for background tick to run
  await new Promise(r => setTimeout(r, 150))

  // After tick: warming up should be false and data present
  const snap1 = watcher.getSnapshot()
  assert.equal(snap1.warmingUp, false)
  assert.equal(snap1.stats.total.toolCalls, 1)

  watcher.stop()
})

test('fileCount diagnostic: reflects current cached file count', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-watcher-'))
  const job = path.join(root, 'j1')
  fs.mkdirSync(job)
  const now = Date.now()
  fs.writeFileSync(path.join(job, 's1.jsonl'), line('m1', 'claude-haiku-5-5', { input_tokens: 1000 }, 1, '2026-11-17T10:00:00Z') + '\n')
  fs.writeFileSync(path.join(job, 's2.jsonl'), line('m2', 'claude-haiku-5-5', { input_tokens: 1000 }, 1, '2026-11-17T10:00:00Z') + '\n')
  fs.utimesSync(path.join(job, 's1.jsonl'), now / 1000, now / 1000)
  fs.utimesSync(path.join(job, 's2.jsonl'), now / 1000, now / 1000)

  const state = createWatcherState({ table, windowDays: 7 })
  assert.equal(state.files.size, 0)

  await scanOnce(state, [root])
  assert.equal(state.files.size, 2)
})

test('snapshot days window: clamped to windowDays', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-watcher-'))
  const job = path.join(root, 'j1')
  fs.mkdirSync(job)
  const now = Date.now()
  fs.writeFileSync(path.join(job, 's.jsonl'), line('m1', 'claude-haiku-5-5', { input_tokens: 1000 }, 1, '2026-11-17T10:00:00Z') + '\n')
  fs.utimesSync(path.join(job, 's.jsonl'), now / 1000, now / 1000)

  const state = createWatcherState({ table, windowDays: 3 })
  await scanOnce(state, [root])

  // Request 7 days, but state only has 3 days cached, so only 3-day window honored
  const snap = snapshotFromState(state, 7)
  assert.equal(snap.stats.windowDays, 3)
})

test('removed file: evicted from cache when it no longer exists on disk', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-watcher-'))
  const job = path.join(root, 'j1')
  fs.mkdirSync(job)
  const transcript = path.join(job, 's.jsonl')
  const now = Date.now()
  fs.writeFileSync(transcript, line('m1', 'claude-haiku-5-5', { input_tokens: 1000 }, 1, '2026-11-17T10:00:00Z') + '\n')
  fs.utimesSync(transcript, now / 1000, now / 1000)

  const state = createWatcherState({ table, windowDays: 7 })
  await scanOnce(state, [root])
  assert.equal(state.files.size, 1)

  // Remove the file
  fs.unlinkSync(transcript)

  // Next scan should evict it
  await scanOnce(state, [root])
  assert.equal(state.files.size, 0)
})

test('truncated file: reset offset and re-parse from scratch on size regression', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-watcher-'))
  const job = path.join(root, 'j1')
  fs.mkdirSync(job)
  const transcript = path.join(job, 's.jsonl')
  const now = Date.now()

  // First file has two tool calls across two lines.
  const long1 = line('m1', 'claude-haiku-5-5', { input_tokens: 1000 }, 1, '2026-11-17T10:00:00Z')
  const long2 = line('m2', 'claude-haiku-5-5', { input_tokens: 1000 }, 1, '2026-11-17T10:01:00Z')
  fs.writeFileSync(transcript, long1 + '\n' + long2 + '\n')
  fs.utimesSync(transcript, now / 1000, now / 1000)

  const state = createWatcherState({ table, windowDays: 7 })
  await scanOnce(state, [root])
  assert.equal(snapshotFromState(state).stats.total.toolCalls, 2)
  const sizeBefore = state.files.get(transcript)?.offset
  assert.ok(sizeBefore && sizeBefore > 0)

  // Truncate to a shorter file with a single, different tool call. If the
  // watcher kept the stale offset it would either skip this content
  // entirely (offset past EOF) or miss re-parsing it from byte 0.
  fs.writeFileSync(transcript, line('m3', 'claude-haiku-5-5', { input_tokens: 500 }, 1, '2026-11-17T11:00:00Z') + '\n')
  fs.utimesSync(transcript, (now + 1000) / 1000, (now + 1000) / 1000)

  await scanOnce(state, [root])

  const entry2 = state.files.get(transcript)
  assert.ok(entry2)
  assert.equal(entry2.offset, fs.statSync(transcript).size) // caught up to the new, shorter file
  assert.equal(snapshotFromState(state).stats.total.toolCalls, 1) // re-parsed from scratch, not stuck on stale offset
})

test('multiple roots: discovers files across all roots', async () => {
  const root1 = fs.mkdtempSync(path.join(os.tmpdir(), 'af-watcher-'))
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'af-watcher-'))
  const now = Date.now()

  const job1 = path.join(root1, 'j1')
  const job2 = path.join(root2, 'j2')
  fs.mkdirSync(job1)
  fs.mkdirSync(job2)

  fs.writeFileSync(path.join(job1, 's.jsonl'), line('m1', 'claude-haiku-5-5', { input_tokens: 1000 }, 1, '2026-11-17T10:00:00Z') + '\n')
  fs.writeFileSync(path.join(job2, 's.jsonl'), line('m2', 'claude-haiku-5-5', { input_tokens: 2000 }, 2, '2026-11-17T10:00:00Z') + '\n')
  fs.utimesSync(path.join(job1, 's.jsonl'), now / 1000, now / 1000)
  fs.utimesSync(path.join(job2, 's.jsonl'), now / 1000, now / 1000)

  const state = createWatcherState({ table, windowDays: 7 })
  await scanOnce(state, [root1, root2])

  assert.equal(state.files.size, 2)
  const snap = snapshotFromState(state)
  assert.equal(snap.stats.total.toolCalls, 3)
})

test('chunked read: a line straddling the internal 4MB read boundary is still parsed correctly', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-watcher-'))
  const job = path.join(root, 'j1')
  fs.mkdirSync(job)
  const transcript = path.join(job, 's.jsonl')
  const now = Date.now()

  // Pad past the first 4MB chunk with filler lines of odd length so a real
  // line's bytes don't land neatly on the 4,194,304-byte chunk boundary,
  // then add the line we'll assert on, then more filler after it — so
  // tailFile's internal chunk loop must carry a split line across chunks.
  const filler = (n: number) => line('f' + n, 'claude-haiku-5-5', { input_tokens: 1 }, 0, '2026-11-17T09:00:00Z') + '\n'
  const parts: string[] = []
  let bytes = 0
  let n = 0
  while (bytes < 4 * 1024 * 1024 + 500) {
    const chunk = filler(n++)
    parts.push(chunk)
    bytes += Buffer.byteLength(chunk, 'utf8')
  }
  const marker = line('marker', 'claude-opus-5-5', { input_tokens: 777, output_tokens: 333 }, 4, '2026-11-17T10:30:00Z')
  parts.push(marker + '\n')
  for (let i = 0; i < 50; i++) parts.push(filler(i))
  fs.writeFileSync(transcript, parts.join(''))
  fs.utimesSync(transcript, now / 1000, now / 1000)
  assert.ok(fs.statSync(transcript).size > 4 * 1024 * 1024, 'file must exceed CHUNK_BYTES to exercise multi-chunk tailing')

  const state = createWatcherState({ table, windowDays: 7 })
  await scanOnce(state, [root])

  const snap = snapshotFromState(state)
  assert.equal(snap.stats.total.toolCalls, 4) // only the marker line has tool calls
  assert.equal(snap.stats.byModel.opus.toolCalls, 4)
  const entry = state.files.get(transcript)
  assert.ok(entry)
  assert.equal(entry.offset, fs.statSync(transcript).size) // consumed the whole file, no bytes lost or double-read
  assert.equal(entry.tail, '') // file ends on a newline — nothing left to carry
})

test('nonexistent root: gracefully ignored during discovery', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-watcher-'))
  const job = path.join(root, 'j1')
  fs.mkdirSync(job)
  const now = Date.now()
  fs.writeFileSync(path.join(job, 's.jsonl'), line('m1', 'claude-haiku-5-5', { input_tokens: 1000 }, 1, '2026-11-17T10:00:00Z') + '\n')
  fs.utimesSync(path.join(job, 's.jsonl'), now / 1000, now / 1000)

  const state = createWatcherState({ table, windowDays: 7 })
  await scanOnce(state, [root, '/nonexistent/path'])

  assert.equal(state.files.size, 1)
  const snap = snapshotFromState(state)
  assert.equal(snap.stats.total.toolCalls, 1)
})
