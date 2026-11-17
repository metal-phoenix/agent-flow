/**
 * Stats endpoint: scans Claude Code transcript roots and aggregates helper
 * (sub-agent) activity, tool calls, tokens and API-equivalent cost.
 *
 * Layout read: <root>/<job>/<session>.jsonl (main agent) and
 * <root>/<job>/<session>/subagents/agent-*.jsonl (helpers). A "job" is the
 * project directory (encoded cwd). Read-only; never writes to the roots.
 * Costs are API-equivalent estimates (Max-plan work is not billed per token).
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

/** Parse one transcript file into per-call records (deduped by message id). */
export function parseTranscript(text: string, table: PriceTable) {
  const seen = new Set<string>()
  const days: Record<string, { toolCalls: number; usage: Usage; cost: number }> = {}
  let model = ''
  let toolCalls = 0
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  let cost = 0
  let last = ''
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let e: any
    try { e = JSON.parse(line) } catch { continue } // partial/corrupt line
    if (e?.type !== 'assistant' || !e.message) continue
    const m = e.message
    const key = m.id ? `${m.id}:${e.requestId ?? ''}` : ''
    if (key && seen.has(key)) continue
    if (key) seen.add(key)
    const mdl = typeof m.model === 'string' && !m.model.startsWith('<') ? m.model : ''
    if (mdl) model = mdl
    const u = m.usage ?? {}
    const rec: Usage = {
      input: Number(u.input_tokens) || 0,
      output: Number(u.output_tokens) || 0,
      cacheRead: Number(u.cache_read_input_tokens) || 0,
      cacheWrite: Number(u.cache_creation_input_tokens) || 0,
    }
    const tools = Array.isArray(m.content) ? m.content.filter((c: any) => c?.type === 'tool_use').length : 0
    const c = costOf(rec, rateFor(mdl || model, table))
    toolCalls += tools; cost += c
    usage.input += rec.input; usage.output += rec.output; usage.cacheRead += rec.cacheRead; usage.cacheWrite += rec.cacheWrite
    const ts = typeof e.timestamp === 'string' ? e.timestamp : ''
    if (ts > last) last = ts
    const day = ts.slice(0, 10) || 'unknown'
    const d = (days[day] ??= { toolCalls: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 })
    d.toolCalls += tools; d.cost += c
    d.usage.input += rec.input; d.usage.output += rec.output; d.usage.cacheRead += rec.cacheRead; d.usage.cacheWrite += rec.cacheWrite
  }
  return { model, toolCalls, usage, cost, days, last }
}

const sumTokens = (u: Usage) => u.input + u.output + u.cacheRead + u.cacheWrite

function listJsonl(dir: string): string[] {
  try { return fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => path.join(dir, f)) } catch { return [] }
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

export function computeStats(opts: StatsOptions) {
  const table = opts.table ?? loadPricing()
  const now = opts.now ?? Date.now()
  const windowDays = opts.days ?? 7
  const runMs = (opts.runningSeconds ?? 120) * 1000
  const cutoff = now - windowDays * 86400_000
  const today = new Date(now).toISOString().slice(0, 10)

  const helpers: HelperStat[] = []
  const byModel: Record<string, Bucket> = {}
  const byJob: Record<string, Bucket & { running: number; byModel: Record<string, number> }> = {}
  const byDay: Record<string, Bucket> = {}
  const mainByJob: Record<string, Bucket> = {}

  for (const root of opts.roots) {
    let jobs: string[] = []
    try { jobs = fs.readdirSync(root) } catch { continue }
    for (const job of jobs) {
      const jobDir = path.join(root, job)
      const files: { file: string; helper: boolean }[] = []
      for (const f of listJsonl(jobDir)) files.push({ file: f, helper: false })
      let sessions: string[] = []
      try { sessions = fs.readdirSync(jobDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) } catch { /* none */ }
      for (const s of sessions) for (const f of listJsonl(path.join(jobDir, s, 'subagents'))) files.push({ file: f, helper: true })

      for (const { file, helper } of files) {
        let st: fs.Stats
        try { st = fs.statSync(file) } catch { continue }
        if (st.mtimeMs < cutoff) continue
        let text: string
        try { text = fs.readFileSync(file, 'utf8') } catch { continue }
        const p = parseTranscript(text, table)
        const fam = modelFamily(p.model || 'unknown')
        const running = helper && now - st.mtimeMs <= runMs
        const j = (byJob[job] ??= { ...emptyBucket(), running: 0, byModel: {} })
        // Per-day cost/tool/token totals include main + helper activity within the window.
        for (const [day, d] of Object.entries(p.days)) {
          if (day < new Date(cutoff).toISOString().slice(0, 10)) continue
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
        } else {
          (mainByJob[job] ??= emptyBucket()).toolCalls += p.toolCalls
        }
      }
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
