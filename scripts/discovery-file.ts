/**
 * Discovery-file writer for the headless relay (scripts/relay.ts).
 *
 * Split out of relay.ts so it has no dependency on HookServer (which pulls
 * in the `vscode` module, only shimmed for the esbuild app bundle) — this
 * keeps it cheap to unit test directly.
 *
 * Each running instance writes a small JSON file naming its hook port and
 * PID. The VS Code extension's hook forwarder reads these to find live
 * instances; nothing reads them in a headless deployment, so a write
 * failure here must never crash the server (see writeDiscoveryFile).
 */
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import * as os from 'os'

import { WORKSPACE_HASH_LENGTH, resolveDiscoveryDir } from '../extension/src/constants'

/** Resolved per-call (not cached at module load) so tests can point
 *  AGENT_FLOW_DISCOVERY_DIR at a fresh directory per case. */
function getDiscoveryDir(): string {
  return resolveDiscoveryDir(os.homedir())
}

function normalizePath(p: string): string {
  let resolved = path.resolve(p)
  try { resolved = fs.realpathSync(resolved) } catch { /* use path.resolve result if realpathSync fails */ }
  return resolved
}

function hashWorkspace(workspace: string): string {
  return crypto.createHash('sha256').update(normalizePath(workspace)).digest('hex').slice(0, WORKSPACE_HASH_LENGTH)
}

let discoveryFilePath: string | null = null

/**
 * Advertise this instance's hook port for the VS Code extension's hook
 * forwarder to find. Best-effort only: discovery files are irrelevant in a
 * headless deployment (nothing reads them there), so a write failure — e.g.
 * a read-only container filesystem — must not crash the server. Logs a
 * warning and carries on with discovery simply unavailable.
 */
export function writeDiscoveryFile(port: number, workspace: string): void {
  try {
    const dir = getDiscoveryDir()
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const hash = hashWorkspace(workspace)
    discoveryFilePath = path.join(dir, `${hash}-${process.pid}.json`)
    fs.writeFileSync(discoveryFilePath, JSON.stringify({ port, pid: process.pid, workspace: normalizePath(workspace) }, null, 2) + '\n')
  } catch (err) {
    discoveryFilePath = null
    console.warn('[relay] Could not write discovery file — VS Code extension discovery will be unavailable, continuing without it:', err instanceof Error ? err.message : err)
  }
}

export function removeDiscoveryFile(): void {
  if (discoveryFilePath) {
    try { fs.unlinkSync(discoveryFilePath) } catch { /* expected if file was already removed */ }
  }
}
