import { DEFAULT_RELAY_PORT } from '../../extension/src/constants'

/** Parse CLI arguments. Keeps it simple — no dependencies. */
export function parseArgs(argv: string[]) {
  let port = DEFAULT_RELAY_PORT
  let host = process.env.AGENT_FLOW_HOST || '127.0.0.1'
  let open = true
  let verbose = false
  let setupHooks = process.env.AGENT_FLOW_SETUP_HOOKS === 'true'

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if ((arg === '--port' || arg === '-p') && argv[i + 1]) {
      const n = parseInt(argv[i + 1], 10)
      if (!isNaN(n) && n > 0 && n < 65536) port = n
      i++
    } else if (arg === '--host' && argv[i + 1]) {
      host = argv[i + 1]
      i++
    } else if (arg === '--no-open') {
      open = false
    } else if (arg === '--setup-hooks') {
      setupHooks = true
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Usage: agent-flow [options]

Options:
  -p, --port <number>  Port for the server (default: ${DEFAULT_RELAY_PORT})
  --host <address>     Address to bind the server to (default: 127.0.0.1,
                        or AGENT_FLOW_HOST). Transcript tailing works without
                        hooks, so a loopback bind is enough for most setups;
                        set this when running behind a reverse proxy.
  --no-open            Don't open the browser automatically
  --setup-hooks        Install Claude Code hooks for zero-latency permission
                        events (also AGENT_FLOW_SETUP_HOOKS=true). Off by
                        default — transcript tailing covers everything else.
  -v, --verbose        Show detailed event logs
  -h, --help           Show this help message
`)
      process.exit(0)
    }
  }

  return { port, host, open, verbose, setupHooks }
}
