# Agent Flow

Real-time visualization of Claude Code and Codex agent orchestration. Watch your agents think, branch, and coordinate as they work. [Demo video here](https://www.youtube.com/watch?v=Ud6eDrFN-TA). 

![Agent Flow visualization](https://res.cloudinary.com/dxlvclh9c/image/upload/v1773924941/screenshot_e7yox3.png)

## Why Agent Flow?

I built Agent Flow while developing [Antics](https://antics.gg), a game creation platform driven by AI agents. Debugging agent behavior was painful, so we made it visual. Now we're sharing it.

Claude Code is powerful, but its execution is a black box — you see the final result, not the journey. Agent Flow makes the invisible visible:

- **Understand agent behavior** — See how Claude breaks down problems, which tools it reaches for, and how subagents coordinate
- **Debug tool call chains** — When something goes wrong, trace the exact sequence of decisions and tool calls that led there
- **See where time is spent** — Identify slow tool calls, unnecessary branching, or redundant work at a glance
- **Learn by watching** — Build intuition for how to write better prompts by observing how Claude interprets and executes them

## Features

- **Live agent visualization**: Watch agent execution as an interactive node graph with real-time tool calls, branching, and return flows
- **Claude Code + Codex**: Auto-detects sessions from both runtimes concurrently and shows them side-by-side, or restrict to one via the `agentVisualizer.runtime` setting
- **Claude Code hooks**: Lightweight HTTP hook server receives events directly from Claude Code for zero-latency streaming
- **Codex rollout tailing**: Reads `~/.codex/sessions/**/rollout-*.jsonl` (respects `CODEX_HOME`) and surfaces tool calls, reasoning, and authoritative token counts from Codex's own event stream
- **Multi-session support**: Track multiple concurrent agent sessions with tabs
- **Interactive canvas**: Pan, zoom, click agents and tool calls to inspect details
- **Timeline & transcript panels**: Review the full execution timeline, file attention heatmap, and message transcript
- **JSONL log file support**: Point at any JSONL event log to replay or watch agent activity

## Getting Started

### Quick Start (no VS Code required)

```bash
npx agent-flow-app
```

This starts the visualizer in your browser. Start a Claude Code session in another terminal — events will stream in real-time.

Options:
- `--port <number>` — change the server port (default: 3001)
- `--no-open` — don't open the browser automatically
- `--verbose` — show detailed event logs

### Standalone Web App (from source)

```bash
git clone https://github.com/patoles/agent-flow.git
cd agent-flow
pnpm i
pnpm run setup      # configure Claude Code hooks (one-time)
pnpm run dev        # start the web app + event relay
```

Open http://localhost:3000 and start a Claude Code session in another terminal — events will stream to the browser in real-time.

### VS Code Extension

1. Install the extension
2. Open the Command Palette (`Cmd+Shift+P`) and run **Agent Flow: Open Agent Flow**
3. Start a Claude Code or Codex session in your workspace — Agent Flow will auto-detect it

Agent Flow automatically configures Claude Code hooks the first time you open the panel. To manually reconfigure, run **Agent Flow: Configure Claude Code Hooks** from the Command Palette.

### Runtime selection

By default Agent Flow watches both Claude Code (`~/.claude/projects/`) and Codex (`~/.codex/sessions/`) concurrently in all three entry points (VS Code extension, `pnpm run dev`, `npx agent-flow-app`). Sessions are shown side-by-side and tagged by runtime. If you only use one, the other is a harmless no-op — no visible effect, no user action needed.

To restrict to one runtime:

- **VS Code extension:** set `agentVisualizer.runtime` to `"auto"` / `"claude"` / `"codex"` in your settings
- **`pnpm run dev` and `npx agent-flow-app`:** set the `AGENT_FLOW_RUNTIME` environment variable to `claude` or `codex` (defaults to watching both)

For non-default Codex installs, set the `CODEX_HOME` environment variable.

### JSONL Event Log

You can also point Agent Flow at a JSONL event log file:

1. Set `agentVisualizer.eventLogPath` in your VS Code settings to the path of a `.jsonl` file
2. Agent Flow will tail the file and visualize events as they arrive

## Commands

| Command | Description |
|---------|-------------|
| `Agent Flow: Open Agent Flow` | Open the visualizer panel |
| `Agent Flow: Open Agent Flow to Side` | Open in a side editor column |
| `Agent Flow: Connect to Running Agent` | Manually connect to an agent session |
| `Agent Flow: Configure Claude Code Hooks` | Set up Claude Code hooks for live streaming |

## Keyboard Shortcut

| Shortcut | Action |
|----------|--------|
| `Cmd+Alt+A` (Mac) / `Ctrl+Alt+A` (Win/Linux) | Open Agent Flow |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `agentVisualizer.runtime` | `"auto"` | Which agent runtime(s) to watch: `"auto"` (both), `"claude"`, or `"codex"` |
| `agentVisualizer.devServerPort` | `0` | Development server port (0 = production mode) |
| `agentVisualizer.eventLogPath` | `""` | Path to a JSONL event log file to watch |
| `agentVisualizer.autoOpen` | `false` | Auto-open when an agent session starts |

## Requirements

- [Node.js](https://nodejs.org/) 20+ (LTS recommended)
- [pnpm](https://pnpm.io/)
- Claude Code CLI
- For the VS Code extension: a VSCode-compatible IDE 1.85+ (e.g. [VS Code](https://code.visualstudio.com/), [Cursor](https://cursor.sh/), [Windsurf](https://windsurf.com/))

## Development

```bash
pnpm i              # install dependencies for all packages
pnpm run setup      # configure Claude Code hooks (one-time)
pnpm run dev        # start dev server + event relay
```

`pnpm run dev` starts both the Next.js dev server and an event relay that receives Claude Code events and streams them to the browser via SSE.

Other scripts:

| Script | Description |
|--------|-------------|
| `pnpm run dev:demo` | Start with demo/mock data |
| `pnpm run dev:relay` | Run the event relay server standalone |
| `pnpm run dev:extension` | Watch-build the extension |
| `pnpm run build:all` | Production build (webview + extension) |
| `pnpm run build:web` | Build the Next.js web app |
| `pnpm run build:extension` | Build the extension |
| `pnpm run build:webview` | Build the webview assets |

## Star History

[![Star History Chart](https://api.star-history.com/chart?repos=patoles/agent-flow&type=date&legend=bottom-right)](https://www.star-history.com/?repos=patoles%2Fagent-flow&type=date&legend=bottom-right)


## Author

Created by [Simon Patole](https://github.com/patoles), for [Antics](https://antics.gg).

## Privacy & Telemetry

This fork (metal-phoenix) has **completely removed all telemetry** — there is no opt-out,
no installation ID, and no outbound connections to any telemetry endpoints. The Agent Flow
code that collected session metadata has been deleted entirely (`scripts/telemetry.ts` and
`scripts/telemetry/*.ts`), and Next.js's own built-in telemetry is also disabled.

The upstream Agent Flow (patoles/agent-flow) ships opt-out anonymous usage telemetry in its
published `npx agent-flow-app` binary. For upstream documentation on that behavior, see the v0.8.1
entry in [extension/CHANGELOG.md](extension/CHANGELOG.md).

## metal-phoenix fork

This is metal-phoenix's fork of [patoles/agent-flow](https://github.com/patoles/agent-flow), created for production deployment and security hardening.

**Key differences from upstream:**

1. **Telemetry fully removed** — no installation IDs, no telemetry data collection, no outbound endpoints
2. **Hook installation is opt-in** — pass `--setup-hooks` or set `AGENT_FLOW_SETUP_HOOKS=true` to enable Claude Code hooks; default behavior uses transcript tailing only
3. **Configurable server binding** — `--host` flag or `AGENT_FLOW_HOST` env var for binding address (default `127.0.0.1`); when binding to non-loopback, set `AGENT_FLOW_ALLOWED_HOST` to match your reverse proxy's Host header
4. **Multi-root transcript watching** — `AGENT_FLOW_ROOTS` env var (comma-separated paths) to watch transcripts from multiple machines over NFS or sync
5. **Containerized** — Dockerfile and `.dockerignore` for running the standalone server in production (node:22-slim, non-root user)
6. **Dependency vulnerabilities fixed** — line-by-line audit completed; `next` and `vite` bumped, transitive deps pinned; `pnpm audit` reduced from 64 to 11 (0 critical)

For detailed audit findings and production deployment guidance, see [docs/AUDIT-2026-11.md](docs/AUDIT-2026-11.md) and [docs/INTEGRATION-PLAN.md](docs/INTEGRATION-PLAN.md).

**Attribution:** This is metal-phoenix's fork of patoles/agent-flow, created by Simon Patole for Antics (https://antics.gg). Apache-2.0 licensed — see LICENSE.

### Deploy on Prodigy

```bash
cp .env.example .env          # edit paths; .env is git-ignored
docker compose up -d --build
```

- **No public port**: the service only `expose`s 3001 on the external docker network `lifeos` (override with `LIFEOS_NETWORK`). The LifeOS proxy must join that network; see [docs/ha/lifeos-proxy.md](docs/ha/lifeos-proxy.md) for the route needed.
- **Transcripts, read-only**: `BOB1_TRANSCRIPTS` (default `/home/scott/builder/home/.claude/projects`) → `/transcripts/bob1`; `BOB2_TRANSCRIPTS` (default `/srv/agent-flow/bob2-transcripts`) → `/transcripts/bob2`. Roots are set through `AGENT_FLOW_ROOTS` in `docker-compose.yml`.
- **Bob 2** is not reachable from Prodigy directly. On Bob 2's runner, schedule `scripts/ship-transcripts.sh scott@prodigy /srv/agent-flow/bob2-transcripts` (rsync over ssh, `*.jsonl` only, one-way, needs an ssh key for that account and `rsync` on both ends). Alternative: NFS-export the WSL folder (see INTEGRATION-PLAN.md). Until one is set up the Bob 2 folder is simply empty.
- **Hooks are not installed** (`AGENT_FLOW_SETUP_HOOKS` unset) and telemetry does not exist in this fork.
- `AGENT_FLOW_ALLOWED_HOST` must equal the Host header the proxy sends (default `agent-flow:3001`).

### Stats endpoint

`GET /stats?days=7` (full JSON) and `GET /stats/flat` (flat keys for Home Assistant REST sensors) report helpers running now (sub-agent transcripts modified in the last 120 s), helpers/tool calls/tokens/cost per job, per model family and per day. A "job" is the Claude project directory (encoded working directory). Costs are **API-equivalent estimates**: Max-plan work is not billed per token. Prices live in one file, [config/pricing.json](config/pricing.json) (USD per million tokens; override with `AGENT_FLOW_PRICING`); check them against current Anthropic pricing. Transcripts are only read, never written.

Home Assistant files (Build view, REST sensors, LifeOS proxy spec) are in [docs/ha/](docs/ha/). Not yet tested against a live Home Assistant.

## License

Apache 2.0 — see [LICENSE](LICENSE) for details.

The name "Agent Flow" and associated logos are trademarks of Simon Patole. See [TRADEMARK.md](TRADEMARK.md) for usage guidelines.
