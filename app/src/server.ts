/**
 * Combined HTTP server: serves the visualizer UI and streams events via SSE.
 * Reuses the extension's hook server, transcript parser, and session watcher.
 */
import * as http from 'http'
import { exec, execFile } from 'child_process'

import { createRelay } from '../../scripts/relay'
import { serveStatic } from './static'
import { isAllowedRequestHost } from '../../extension/src/request-guard'

interface ServerOptions {
  port: number
  host: string
  openBrowser: boolean
  workspace: string
  verbose?: boolean
}

export async function startServer(options: ServerOptions) {
  const { port, host, openBrowser, workspace } = options

  const relay = await createRelay({ workspace, verbose: options.verbose })

  // Requests that don't match a loopback Host header, or the configured
  // AGENT_FLOW_ALLOWED_HOST (set when running behind a reverse proxy), are
  // rejected outright — see request-guard.ts.
  const allowedHost = process.env.AGENT_FLOW_ALLOWED_HOST

  const server = http.createServer((req, res) => {
    if (!isAllowedRequestHost(req.headers.host, allowedHost)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' })
      res.end('Forbidden')
      return
    }

    // SSE endpoint
    if (req.url === '/events') {
      return relay.handleSSE(req, res)
    }

    // Static files (UI)
    if (req.method === 'GET') {
      return serveStatic(req, res)
    }

    res.writeHead(404)
    res.end('Not found')
  })

  server.listen(port, host, () => {
    const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host
    const url = `http://${displayHost}:${port}`
    console.log(`Server running at ${url}`)
    if (host !== '127.0.0.1' && host !== 'localhost') {
      console.log(`Bound to ${host} — make sure AGENT_FLOW_ALLOWED_HOST matches the Host header reaching this server (e.g. a reverse proxy's upstream Host).`)
    }
    console.log('Waiting for agent events...\n')

    if (openBrowser) {
      openURL(url)
    }
  })

  // Cleanup on exit. Idempotent — repeat signals (Ctrl+C spam, SIGTERM+SIGHUP,
  // etc.) would otherwise run the shutdown twice.
  let shuttingDown = false
  function cleanup() {
    if (shuttingDown) return
    shuttingDown = true
    server.close()
    relay.dispose()
    process.exit(0)
  }
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
  // SIGHUP fires when the controlling terminal closes (SSH session drops, tmux
  // pane killed). Without a handler, Node's default behavior is to terminate
  // without running cleanup — so session_end never flushes.
  process.on('SIGHUP', cleanup)
}

function openURL(url: string) {
  if (process.platform === 'win32') {
    // 'start' is a shell builtin on Windows — must use exec, not execFile
    exec(`start "" "${url}"`)
  } else {
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
    execFile(cmd, [url], () => {})
  }
}
