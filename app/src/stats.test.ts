import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { costOf, rateFor, modelFamily, parseTranscript, computeStats, flattenStats, loadPricing } from './stats'

const table = loadPricing(undefined)
const NOW = Date.parse('2026-11-17T12:00:00Z')

function line(id: string, model: string, usage: object, tools: number, ts: string) {
  return JSON.stringify({ type: 'assistant', timestamp: ts, requestId: 'r' + id, message: { id, model, usage, content: Array.from({ length: tools }, () => ({ type: 'tool_use' })) } })
}

test('costOf maths per million tokens', () => {
  const c = costOf({ input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 }, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 })
  assert.ok(Math.abs(c - 22.05) < 1e-9)
  assert.equal(costOf({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, table.default), 0)
})

test('rateFor matches family substring, falls back to default', () => {
  assert.equal(rateFor('claude-opus-5-5', table).output, 75)
  assert.equal(rateFor('claude-haiku-5-5', table).input, 1)
  assert.equal(rateFor('mystery', table), table.default)
  assert.equal(modelFamily('claude-sonnet-5-5'), 'sonnet')
  assert.equal(modelFamily('x'), 'other')
})

test('parseTranscript dedupes, skips bad lines, counts tools', () => {
  const l = line('a', 'claude-haiku-5-5', { input_tokens: 1000, output_tokens: 500 }, 2, '2026-11-17T10:00:00Z')
  const p = parseTranscript(['{bad', l, l, ''].join('\n'), table)
  assert.equal(p.toolCalls, 2)
  assert.equal(p.usage.input, 1000)
  assert.ok(Math.abs(p.cost - (1000 * 1 + 500 * 5) / 1e6) < 1e-12)
  assert.equal(p.model, 'claude-haiku-5-5')
})

test('computeStats: running, per job, per model, per day, flat', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-stats-'))
  const job = path.join(root, '-work-job-1')
  fs.mkdirSync(path.join(job, 's1', 'subagents'), { recursive: true })
  fs.writeFileSync(path.join(job, 's1.jsonl'), line('m1', 'claude-sonnet-5-5', { input_tokens: 1_000_000 }, 1, '2026-11-17T09:00:00Z'))
  const live = path.join(job, 's1', 'subagents', 'agent-live.jsonl')
  const old = path.join(job, 's1', 'subagents', 'agent-old.jsonl')
  fs.writeFileSync(live, line('h1', 'claude-haiku-5-5', { output_tokens: 1_000_000 }, 3, '2026-11-17T11:59:00Z'))
  fs.writeFileSync(old, line('h2', 'claude-haiku-5-5', { output_tokens: 1_000_000 }, 1, '2026-11-16T11:00:00Z'))
  fs.utimesSync(live, NOW / 1000 - 30, NOW / 1000 - 30)
  fs.utimesSync(old, NOW / 1000 - 3600, NOW / 1000 - 3600)
  fs.utimesSync(path.join(job, 's1.jsonl'), NOW / 1000 - 3600, NOW / 1000 - 3600)

  const s = computeStats({ roots: [root, '/nonexistent'], table, now: NOW })
  assert.equal(s.running.helpers, 1)
  assert.equal(s.byJob['-work-job-1'].helpers, 2)
  assert.equal(s.byJob['-work-job-1'].running, 1)
  assert.equal(s.byModel.haiku.helpers, 2)
  assert.equal(s.byModel.haiku.toolCalls, 4)
  assert.equal(s.byModel.sonnet.costUsd, 3)
  assert.equal(s.byDay['2026-11-17'].costUsd, 8)   // 3 sonnet + 5 haiku
  assert.equal(s.byDay['2026-11-16'].costUsd, 5)
  assert.equal(s.today.toolCalls, 4)
  assert.equal(s.total.costUsd, 13)
  const f = flattenStats(s)
  assert.equal(f.helpers_running_haiku, 1)
  assert.equal(f.cost_today_usd, 8)
  assert.match(f.cost_label, /API-equivalent/)
})

test('window excludes old files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-stats-'))
  fs.mkdirSync(path.join(root, 'j'))
  const f = path.join(root, 'j', 's.jsonl')
  fs.writeFileSync(f, line('x', 'claude-opus-5-5', { input_tokens: 10 }, 1, '2026-10-01T00:00:00Z'))
  fs.utimesSync(f, NOW / 1000 - 30 * 86400, NOW / 1000 - 30 * 86400)
  assert.equal(computeStats({ roots: [root], table, now: NOW }).total.toolCalls, 0)
})
