/**
 * Agent Flow — standalone web app for visualizing AI agent orchestration.
 *
 * Starts a local server that:
 *   1. Receives events from agent hooks
 *   2. Watches JSONL transcript files for active sessions
 *   3. Serves the visualizer UI and streams events via SSE
 *   4. Opens the browser automatically
 *
 * Usage: npx @agent-flow/app [--port <number>] [--host <address>] [--no-open] [--setup-hooks]
 */
import { parseArgs } from './args'
import { ensureSetup } from '../../scripts/setup'
import { startServer } from './server'

const args = parseArgs(process.argv.slice(2))

console.log('Agent Flow\n')

// Hooks are opt-in (--setup-hooks / AGENT_FLOW_SETUP_HOOKS=true). Transcript
// tailing (scripts/relay.ts) already watches ~/.claude/projects without them;
// hooks only add zero-latency permission-prompt detection on top of that, and
// installing them means writing into the user's ~/.claude/settings.json.
if (args.setupHooks) {
  ensureSetup()
} else {
  console.log('Hooks not installed (pass --setup-hooks to enable zero-latency permission events). Watching transcripts directly.\n')
}

// Start the server
startServer({
  port: args.port,
  host: args.host,
  openBrowser: args.open,
  workspace: process.cwd(),
  verbose: args.verbose,
})
