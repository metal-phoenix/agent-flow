/**
 * Shared relay module — receives agent events and streams them to SSE clients.
 * Used by both the dev relay server and the standalone app.
 */
import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

import { HookServer } from '../extension/src/hook-server'
import { AgentEvent, SessionInfo, WatchedSession } from '../extension/src/protocol'
import { TranscriptParser } from '../extension/src/transcript-parser'
import { readNewFileLines, foldPathCase } from '../extension/src/fs-utils'
import { scanSubagentsDir, readSubagentNewLines, newestSubagentMtime } from '../extension/src/subagent-watcher'
import { followSession } from '../extension/src/session-relocation'
import { handlePermissionDetection } from '../extension/src/permission-detection'
import { CodexSessionWatcher } from '../extension/src/codex-session-watcher'
import {
  INACTIVITY_TIMEOUT_MS, SCAN_INTERVAL_MS, ACTIVE_SESSION_AGE_S, POLL_FALLBACK_MS,
  SESSION_ID_DISPLAY, SYSTEM_PROMPT_BASE_TOKENS, ORCHESTRATOR_NAME,
  HOOK_SERVER_NOT_STARTED, resolveTranscriptRoots,
} from '../extension/src/constants'
import { setLogLevel } from '../extension/src/logger'
import { writeDiscoveryFile, removeDiscoveryFile } from './discovery-file'

const MAX_EVENT_BUFFER = 5000
/** Transcript roots to watch — `~/.claude/projects` by default, or every path
 *  in `AGENT_FLOW_ROOTS` (comma-separated) when set, e.g. to also watch a
 *  second machine's project folder mounted/synced locally. */
const CLAUDE_ROOTS = resolveTranscriptRoots(os.homedir())

let relayCreated = false
let verbose = false
function log(...args: unknown[]) {
  if (verbose) console.log(...args)
}

// ─── SSE client management ──────────────────────────────────────────────────

const sseClients = new Set<http.ServerResponse>()

function sendSSE(res: http.ServerResponse, data: unknown) {
  try { res.write(`data: ${JSON.stringify(data)}\n\n`) } catch {
    sseClients.delete(res)
  }
}

function broadcast(data: string) {
  for (const res of sseClients) {
    try { res.write(`data: ${data}\n\n`) } catch {
      sseClients.delete(res)
    }
  }
}

// ─── Event buffering ────────────────────────────────────────────────────────

const eventBuffer = new Map<string, AgentEvent[]>()

function broadcastEvent(event: AgentEvent) {
  const sid = event.sessionId?.slice(0, SESSION_ID_DISPLAY) || '?'
  log(`[event] ${event.type} (session ${sid})`)

  if (event.sessionId) {
    let buf = eventBuffer.get(event.sessionId) || []
    buf.push(event)
    if (buf.length > MAX_EVENT_BUFFER) {
      buf = buf.slice(buf.length - MAX_EVENT_BUFFER)
    }
    eventBuffer.set(event.sessionId, buf)
  }

  broadcast(JSON.stringify({ type: 'agent-event', event }))
}

function broadcastSessionLifecycle(type: 'started' | 'ended' | 'updated', sessionId: string, label: string) {
  if (type === 'started') {
    broadcast(JSON.stringify({
      type: 'session-started',
      session: { id: sessionId, label, status: 'active', startTime: Date.now(), lastActivityTime: Date.now() } as SessionInfo,
    }))
  } else if (type === 'ended') {
    broadcast(JSON.stringify({ type: 'session-ended', sessionId }))
  } else if (type === 'updated') {
    broadcast(JSON.stringify({ type: 'session-updated', sessionId, label }))
  }
}

// ─── Session watcher ────────────────────────────────────────────────────────

const sessions = new Map<string, WatchedSession>()

function elapsed(sessionId?: string): number {
  if (sessionId) {
    const session = sessions.get(sessionId)
    if (session) return (Date.now() - session.sessionStartTime) / 1000
  }
  return 0
}

function emitContextUpdate(agentName: string, session: WatchedSession, sessionId?: string) {
  const bd = session.contextBreakdown
  const total = bd.systemPrompt + bd.userMessages + bd.toolResults + bd.reasoning + bd.subagentResults
  broadcastEvent({
    time: elapsed(sessionId),
    type: 'context_update',
    payload: { agent: agentName, tokens: total, breakdown: { ...bd } },
    sessionId,
  })
}

function emitEvent(event: AgentEvent, sessionId?: string) {
  broadcastEvent(sessionId ? { ...event, sessionId } : event)
}

const parser = new TranscriptParser({
  emit: emitEvent,
  elapsed,
  getSession: (sessionId: string) => sessions.get(sessionId),
  fireSessionLifecycle: (event) => broadcastSessionLifecycle(event.type, event.sessionId, event.label),
  emitContextUpdate,
  scanSubagents: (sessionId: string) => scanSubagentsDir(watcherDelegate, parser, sessionId),
})

const watcherDelegate = {
  emit: emitEvent,
  elapsed,
  getSession: (sessionId: string) => sessions.get(sessionId),
  getLastActivityTime: (sessionId: string) => sessions.get(sessionId)?.lastActivityTime,
  resetInactivityTimer: (sessionId: string) => resetInactivityTimer(sessionId),
}

function resetInactivityTimer(sessionId: string) {
  const session = sessions.get(sessionId)
  if (!session) return

  const wasCompleted = session.sessionCompleted
  session.lastActivityTime = Date.now()
  session.sessionCompleted = false

  if (wasCompleted) {
    broadcastEvent({
      time: elapsed(sessionId),
      type: 'agent_spawn',
      payload: { name: ORCHESTRATOR_NAME, isMain: true, task: session.label, ...(session.model ? { model: session.model } : {}) },
      sessionId,
    })
    broadcastSessionLifecycle('started', sessionId, session.label)
  }

  if (session.inactivityTimer) clearTimeout(session.inactivityTimer)
  session.inactivityTimer = setTimeout(() => {
    if (!session.sessionCompleted && session.sessionDetected) {
      log(`[session] ${sessionId.slice(0, SESSION_ID_DISPLAY)} inactive`)
      session.sessionCompleted = true
      broadcastEvent({
        time: elapsed(sessionId),
        type: 'agent_complete',
        payload: { name: ORCHESTRATOR_NAME },
        sessionId,
      })
      broadcastSessionLifecycle('ended', sessionId, session.label)
    }
  }, INACTIVITY_TIMEOUT_MS)
}

function watchSession(sessionId: string, filePath: string) {
  const defaultLabel = `Session ${sessionId.slice(0, SESSION_ID_DISPLAY)}`
  const session: WatchedSession = {
    sessionId, filePath,
    fileWatcher: null, pollTimer: null, fileSize: 0, fileTail: '',
    sessionStartTime: Date.now(),
    pendingToolCalls: new Map(),
    seenToolUseIds: new Set(),
    seenMessageHashes: new Set(),
    sessionDetected: false, sessionCompleted: false,
    lastActivityTime: Date.now(),
    inactivityTimer: null,
    subagentWatchers: new Map(),
    spawnedSubagents: new Set(),
    inlineProgressAgents: new Set(),
    subagentsDirWatcher: null, subagentsDir: null,
    label: defaultLabel, labelSet: false,
    model: null,
    modelDetectedAgents: new Map(),
    permissionTimer: null, permissionEmitted: false,
    contextBreakdown: { systemPrompt: SYSTEM_PROMPT_BASE_TOKENS, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
  }
  sessions.set(sessionId, session)

  const stat = fs.statSync(filePath)
  const catchUpEntries = parser.prescanExistingContent(filePath, stat.size, session)
  session.fileSize = stat.size
  parser.extractSessionLabel(catchUpEntries, session)

  broadcastSessionLifecycle('started', sessionId, session.label)
  broadcastEvent({
    time: 0, type: 'agent_spawn',
    payload: { name: ORCHESTRATOR_NAME, isMain: true, task: session.label, ...(session.model ? { model: session.model } : {}) },
    sessionId,
  })
  session.sessionDetected = true

  emitContextUpdate(ORCHESTRATOR_NAME, session, sessionId)
  parser.emitCatchUpEntries(catchUpEntries, session, sessionId)

  const watchTranscript = () => fs.watch(session.filePath, (eventType) => {
    if (eventType === 'change') readNewLines(sessionId)
  })
  session.fileWatcher = watchTranscript()

  session.pollTimer = setInterval(() => {
    // Entering a worktree moves the transcript to another project folder
    if (followSession(watcherDelegate, parser, session, CLAUDE_ROOTS)) {
      log(`[session] ${sessionId.slice(0, SESSION_ID_DISPLAY)} moved to ${session.filePath}`)
      session.fileWatcher?.close()
      try { session.fileWatcher = watchTranscript() } catch {}
    }
    readNewLines(sessionId)
    for (const [subPath] of session.subagentWatchers) {
      readSubagentNewLines(watcherDelegate, parser, subPath, sessionId)
    }
    scanSubagentsDir(watcherDelegate, parser, sessionId)
  }, POLL_FALLBACK_MS)

  session.subagentsDir = path.join(path.dirname(filePath), sessionId, 'subagents')
  scanSubagentsDir(watcherDelegate, parser, sessionId)
  resetInactivityTimer(sessionId)

  log(`[session] Watching ${sessionId.slice(0, SESSION_ID_DISPLAY)} — "${session.label}"`)
}

function readNewLines(sessionId: string) {
  const session = sessions.get(sessionId)
  if (!session) return

  const result = readNewFileLines(session.filePath, session.fileSize, session.fileTail)
  if (!result) return
  session.fileSize = result.newSize
  session.fileTail = result.tail
  for (const line of result.lines) {
    parser.processTranscriptLine(line, ORCHESTRATOR_NAME, session.pendingToolCalls, session.seenToolUseIds, sessionId, session.seenMessageHashes)
  }

  handlePermissionDetection(watcherDelegate, ORCHESTRATOR_NAME, session.pendingToolCalls, session, sessionId, session.sessionCompleted, true)
  scanSubagentsDir(watcherDelegate, parser, sessionId)
  resetInactivityTimer(sessionId)
}

// ─── Session scanner ────────────────────────────────────────────────────────

/** Project dirs under `root` whose encoded name matches `workspace` (same-machine match). */
function matchingProjectDirs(root: string, workspace: string): string[] {
  let resolved = workspace
  try { resolved = fs.realpathSync(resolved) } catch {}
  const encoded = resolved.replace(/[^a-zA-Z0-9]/g, '-')

  const dirsToScan: string[] = []
  // Case-folded on Windows — VS Code/shells report `c:\...` while Claude Code
  // encodes `C--...`, so exact string matching never found the project dir there.
  const encodedFolded = foldPathCase(encoded)
  try {
    for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue
      const nameFolded = foldPathCase(dir.name)
      if (nameFolded === encodedFolded || nameFolded.startsWith(encodedFolded + '-')) {
        dirsToScan.push(path.join(root, dir.name))
      }
    }
  } catch {
    // readdir failed — fall back to the exact-match dir if it exists
    const projectDir = path.join(root, encoded)
    if (fs.existsSync(projectDir)) dirsToScan.push(projectDir)
  }
  return dirsToScan
}

/** Every project dir under `root`, unfiltered — used for extra roots (AGENT_FLOW_ROOTS)
 *  pointed at another machine's `.claude/projects`, where workspace-path encoding won't
 *  match this machine's cwd. */
function allProjectDirs(root: string): string[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => path.join(root, d.name))
  } catch { return [] }
}

function scanDirForActiveSessions(dirPath: string) {
  try {
    for (const file of fs.readdirSync(dirPath)) {
      if (!file.endsWith('.jsonl')) continue
      const filePath = path.join(dirPath, file)
      const stat = fs.statSync(filePath)
      const sessionId = path.basename(file, '.jsonl')

      // Subagent writes (including nested workflows/wf_*/ files) keep a
      // session alive when the main JSONL is stale. Only walk the tree when
      // the main file alone doesn't qualify.
      let newestMtime = stat.mtimeMs
      if ((Date.now() - newestMtime) / 1000 > ACTIVE_SESSION_AGE_S) {
        const subMtime = newestSubagentMtime(path.join(dirPath, sessionId, 'subagents'))
        if (subMtime > newestMtime) newestMtime = subMtime
      }

      const ageSeconds = (Date.now() - newestMtime) / 1000
      if (ageSeconds <= ACTIVE_SESSION_AGE_S && !sessions.has(sessionId)) {
        watchSession(sessionId, filePath)
      }
    }
  } catch {}
}

function scanForActiveSessions(workspace: string) {
  // With a single (default) root, only watch sessions whose encoded workspace
  // path matches this process's cwd — the existing single-machine behavior.
  // With multiple roots (AGENT_FLOW_ROOTS), each extra root is typically
  // another machine's `.claude/projects`, where workspace-path encoding is
  // meaningless here — watch every session under it instead.
  const multiRoot = CLAUDE_ROOTS.length > 1
  for (const root of CLAUDE_ROOTS) {
    if (!fs.existsSync(root)) continue
    const dirsToScan = multiRoot ? allProjectDirs(root) : matchingProjectDirs(root, workspace)
    for (const dirPath of dirsToScan) scanDirForActiveSessions(dirPath)
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface Relay {
  /** Handle an incoming SSE connection */
  handleSSE: (req: http.IncomingMessage, res: http.ServerResponse) => void
  /** Clean up all resources */
  dispose: () => void
}

export type RelayRuntimeMode = 'claude' | 'codex' | 'auto'

export interface RelayOptions {
  workspace: string
  verbose?: boolean
  /** Which runtimes to watch. Defaults to AGENT_FLOW_RUNTIME env var, or 'auto'.
   *  Mirrors the extension's `agentVisualizer.runtime` setting so users of the
   *  dev relay and `npx agent-flow-app` have a way to opt out of one runtime. */
  runtime?: RelayRuntimeMode
}

function resolveRuntimeMode(explicit?: RelayRuntimeMode): RelayRuntimeMode {
  if (explicit === 'claude' || explicit === 'codex' || explicit === 'auto') return explicit
  const raw = process.env.AGENT_FLOW_RUNTIME
  return raw === 'claude' || raw === 'codex' ? raw : 'auto'
}

export async function createRelay(options: RelayOptions): Promise<Relay> {
  const { workspace } = options
  verbose = options.verbose ?? false
  // Keep warnings visible without --verbose — actionable hints (e.g. "Codex
  // sessions exist but none match this workspace") must reach the user.
  if (!verbose) setLogLevel('warn')
  if (relayCreated) {
    throw new Error('createRelay() can only be called once per process')
  }
  relayCreated = true

  const mode = resolveRuntimeMode(options.runtime)
  const wantClaude = mode === 'claude' || mode === 'auto'
  const wantCodex = mode === 'codex' || mode === 'auto'
  log(`[relay] Runtime mode: ${mode} (watching: ${[wantClaude && 'claude', wantCodex && 'codex'].filter(Boolean).join(', ')})`)

  let hookServer: HookServer | null = null
  let scanInterval: NodeJS.Timeout | null = null
  let projectDirWatcher: fs.FSWatcher | null = null

  if (wantClaude) {
    hookServer = new HookServer()
    const hookPort = await hookServer.start()
    if (hookPort === HOOK_SERVER_NOT_STARTED) {
      throw new Error('Failed to start hook server (port in use)')
    }

    hookServer.onEvent((event: AgentEvent) => {
      broadcast(JSON.stringify({ type: 'agent-event', event }))
    })

    writeDiscoveryFile(hookPort, workspace)

    scanForActiveSessions(workspace)
    scanInterval = setInterval(() => scanForActiveSessions(workspace), SCAN_INTERVAL_MS)

    const resolved = (() => { try { return fs.realpathSync(workspace) } catch { return workspace } })()
    const encoded = resolved.replace(/[^a-zA-Z0-9]/g, '-')
    // Low-latency trigger for the primary (first) root only — extra roots from
    // AGENT_FLOW_ROOTS rely on the SCAN_INTERVAL_MS poll in scanForActiveSessions.
    const projectDir = path.join(CLAUDE_ROOTS[0], encoded)
    if (fs.existsSync(projectDir)) {
      try {
        projectDirWatcher = fs.watch(projectDir, (_eventType, filename) => {
          if (filename?.endsWith('.jsonl')) scanForActiveSessions(workspace)
        })
      } catch {}
    }
  }

  // ─── Codex runtime ────────────────────────────────────────────────────────
  // Watch Codex rollouts in parallel. No-op if ~/.codex/sessions doesn't
  // exist or no sessions match the current workspace.
  // We don't subscribe to onSessionDetected — it fires together with the
  // lifecycle 'started' event in CodexSessionWatcher.attachSession, so
  // wiring both would double-broadcast session-started to SSE clients.
  let codexWatcher: CodexSessionWatcher | null = null
  if (wantCodex) {
    codexWatcher = new CodexSessionWatcher(workspace)
    codexWatcher.onEvent((event) => broadcastEvent(event))
    codexWatcher.onSessionLifecycle((lifecycle) => {
      broadcastSessionLifecycle(lifecycle.type, lifecycle.sessionId, lifecycle.label)
    })
    codexWatcher.start()
  }

  let relayDisposed = false

  process.on('uncaughtException', (err) => {
    // Preserve default crash-on-uncaught behavior: log, then exit.
    console.error(err)
    process.exit(1)
  })

  return {
    handleSSE(req: http.IncomingMessage, res: http.ServerResponse) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      })

      sseClients.add(res)
      log(`[sse] Client connected (${sseClients.size} total)`)

      req.on('close', () => {
        sseClients.delete(res)
        log(`[sse] Client disconnected (${sseClients.size} total)`)
      })

      // Send current session list (Claude + Codex)
      const sessionList: SessionInfo[] = []
      for (const session of sessions.values()) {
        if (!session.sessionDetected) continue
        sessionList.push({
          id: session.sessionId, label: session.label,
          status: session.sessionCompleted ? 'completed' : 'active',
          startTime: session.sessionStartTime, lastActivityTime: session.lastActivityTime,
        })
      }
      if (codexWatcher) sessionList.push(...codexWatcher.getActiveSessions())
      if (sessionList.length > 0) {
        sendSSE(res, { type: 'session-list', sessions: sessionList })
      }

      // Replay buffered events for the most recent active session
      const sorted = [...sessionList].sort((a, b) => {
        const aActive = a.status === 'active' ? 1 : 0
        const bActive = b.status === 'active' ? 1 : 0
        if (aActive !== bActive) return bActive - aActive
        return b.lastActivityTime - a.lastActivityTime
      })
      if (sorted.length > 0) {
        const buffered = eventBuffer.get(sorted[0].id)
        if (buffered) {
          sendSSE(res, { type: 'agent-event-batch', events: buffered })
        }
      }
    },

    dispose() {
      // Defense in depth — server.ts already guards cleanup(), but direct
      // callers or hot-reload could call this twice.
      if (relayDisposed) return
      relayDisposed = true
      if (wantClaude) {
        removeDiscoveryFile()
        hookServer?.dispose()
        if (scanInterval) clearInterval(scanInterval)
        projectDirWatcher?.close()
        for (const session of sessions.values()) {
          session.fileWatcher?.close()
          if (session.pollTimer) clearInterval(session.pollTimer)
          if (session.inactivityTimer) clearTimeout(session.inactivityTimer)
        }
      }
      codexWatcher?.dispose()
    },
  }
}
