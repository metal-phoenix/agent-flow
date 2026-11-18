# Changelog

## Unreleased (metal-phoenix fork — 2026-11-18, build job 301)

### Why
On Prodigy, the Docker container crash-looped at startup with `Error: ENOENT: no such file or directory, mkdir '/home/node/.claude/agent-flow'`. Root cause: `docker-compose.yml` sets `read_only: true` on the container's root filesystem (with no writable mount at `~/.claude/agent-flow`), but `scripts/relay.ts`'s `writeDiscoveryFile()` unconditionally tried to `mkdirSync`/`writeFileSync` a discovery file there on every startup and threw if it failed, crashing the server. Discovery files are only ever read by the VS Code extension's hook forwarder — they are never needed in this headless server deployment — so a write failure there should never be fatal.

### Added
- `scripts/discovery-file.ts` (NEW): extracted discovery-file write/remove logic into its own module with try/catch wrapping `writeDiscoveryFile(port, workspace)` — on any failure it logs a warning and returns normally instead of throwing, so the server keeps running with discovery simply unavailable.
- `extension/src/constants.ts`: added `resolveDiscoveryDir(homedir, env)` returning `env.AGENT_FLOW_DISCOVERY_DIR` (trimmed) if set and non-blank, else the default `path.join(homedir, '.claude', 'agent-flow')`. Mirrors the existing `resolveTranscriptRoots()` pattern.
- `Dockerfile`: added `RUN mkdir -p /home/node/.claude/agent-flow && chown -R node:node /home/node/.claude` in the runtime stage before `USER node` — so a plain `docker run` has a pre-existing, correctly-owned writable discovery dir out of the box.
- `docker-compose.yml`: added `tmpfs: - /home/node/.claude/agent-flow:uid=1000,gid=1000,mode=0755` to the agent-flow service — gives that path a writable, node-user-owned (ephemeral) mount so the discovery file write succeeds even with `read_only: true` on the root filesystem. (A plain tmpfs mount with no uid/gid options defaults to root ownership, which still fails for the non-root `node` user — confirmed this during manual testing and added the options.)
- New environment variable `AGENT_FLOW_DISCOVERY_DIR` (default `~/.claude/agent-flow`): overrides the discovery-file directory for the headless relay/server for users who want to point it at a different writable path. Scoped to `scripts/relay.ts`/`scripts/discovery-file.ts` only — the VS Code extension's own discovery-file writer (`extension/src/discovery.ts`) is unaffected and still uses the fixed `~/.claude/agent-flow` path, since it always runs on a normal (non-containerized) filesystem.
- `scripts/discovery-file.test.ts` (NEW): tests covering `resolveDiscoveryDir` env var override/default/blank handling, nested parent dir creation, and non-throwing graceful failure when the target path can't be created.
- `scripts/relay.ts`: now imports `writeDiscoveryFile`/`removeDiscoveryFile` from `./discovery-file`.

### Verified
- New tests in scripts/discovery-file.test.ts pass, covering env override, mkdir with nested parents, and graceful failure (logging warning) instead of throwing.
- `docker build .` succeeded. `docker compose up -d --build` with the actual `docker-compose.yml` (`read_only: true`, `cap_drop: [ALL]`, `AGENT_FLOW_HOST=0.0.0.0`, `AGENT_FLOW_ROOTS` pointing at two empty mounted dirs) stayed running past 20 s with no crash and no discovery-file warning (the tmpfs mount made the write succeed). `GET /` → 200; `GET /stats/flat` → 200, JSON body `{"helpers_running":0,"helpers_running_opus":0,"helpers_running_sonnet":0,"helpers_running_haiku":0,"jobs_running":0,"tool_calls_today":0,"tokens_today":0,"cost_today_usd":0,"cost_window_usd":0,"window_days":7,"cost_label":"API-equivalent estimate (Max plan: not billed)","generated_at":"<ISO timestamp>"}`.
- Also verified the crash fix in isolation: without the tmpfs uid/gid options, the write still failed (EACCES, root-owned tmpfs) but the server logged a warning and kept running instead of crashing — confirming the try/catch (not just the tmpfs mount) is what actually prevents the crash-loop.

### Rollback
Revert this commit. No lockfile or schema changes.

### Files
scripts/discovery-file.ts (new), scripts/discovery-file.test.ts (new), scripts/relay.ts, extension/src/constants.ts, Dockerfile, docker-compose.yml

## Unreleased (metal-phoenix fork — 2026-11-18, build job 296)

### Why
Docker build was failing with `ERR_PNPM_IGNORED_BUILDS: Ignored build scripts: esbuild@0.20.2, esbuild@0.27.7`. Root cause: `Dockerfile` ran `corepack enable` without pinning a pnpm version, so corepack resolved to whatever is currently latest (pnpm 12.21.0 in this environment). Meanwhile, `pnpm-workspace.yaml` had the stale `onlyBuiltDependencies` key which pnpm 12.x no longer reads — it now reads `allowBuilds` (a map). Since the key was ignored, pnpm 12 blocked esbuild's postinstall script entirely, breaking the build.

### Added
- `package.json`: added `"packageManager": "pnpm@10.34.9"` to pin the pnpm version via corepack, preventing silent drift to a future incompatible version. Pinned to the latest 10.x release (same major line `.github/workflows/ci.yml` already installs via `pnpm/action-setup@v4 version: 10`) rather than the newer 12.x, so Docker and CI stay on the same pnpm major version instead of diverging.
- `Dockerfile`: added `ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0` before `RUN corepack enable`, and changed `RUN pnpm install --frozen-lockfile` to `RUN corepack install && pnpm install --frozen-lockfile` to ensure the pinned version is actually installed before use
- `pnpm-workspace.yaml`: replaced stale `onlyBuiltDependencies: [esbuild, sharp]` with `allowBuilds: {esbuild: true}` (sharp was dropped — it has no lifecycle scripts, only an npm `build` script, so it was never blocked and didn't need allowlisting; least-privilege: only esbuild's script runs)

### Verified
- Reproduced exact `ERR_PNPM_IGNORED_BUILDS` error in a clean temp dir with pnpm 12.21.0 before fix
- Confirmed `pnpm install --frozen-lockfile` and `pnpm run build:app` both succeed after fix, with pnpm 10.34.9 pinned (the version now in `package.json`)
- Verified both esbuild@0.20.2 and esbuild@0.27.7 postinstall scripts run and no other package's build script runs
- Confirmed the same `allowBuilds` key is also read correctly by pnpm 12.21.0, so the fix isn't tied to one specific pnpm major version
- `docker build` itself could not be run (no docker daemon in this sandbox); the pnpm/corepack steps above are what the Dockerfile's builder stage executes, but the full image build remains open for Prodigy/CI verification

### Rollback
Revert this commit. `pnpm-lock.yaml` is unchanged, so no lockfile regen is needed.

## Unreleased (metal-phoenix fork — 2026-11-17, deploy job 274)

### Why
Deployment prep for Prodigy. The Builder sandbox has no docker, `ss` or access to Prodigy, so the deploy itself still has to be run on Prodigy (steps below).

### Added
- `docker-compose.lan.yml`: optional override publishing the port on one private LAN/tailscale IP only (`AGENT_FLOW_BIND`, `AGENT_FLOW_PORT`).
- `scripts/healthcheck.sh`: checks UI (200) and `/stats` (JSON); exit non-zero means roll back with `docker compose down`.
- README "Prodigy runbook": URL/port, start/stop/update/rollback and health-check commands, port-free check.

### Verified
Job 230 fixes are on main: telemetry code removed, hooks opt-in (`AGENT_FLOW_SETUP_HOOKS`), Dockerfile present. No secrets added (`.env` git-ignored).

### Rollback
`docker compose down`; revert this commit.

## Unreleased (metal-phoenix fork — 2026-11-17, Prodigy deployment)

### Why
Put the audited fork live on Prodigy with a Home Assistant "Build" view and usage/cost stats for the helper agents.

### Added
- `docker-compose.yml` + `.env.example`: no published ports (external docker network), read-only transcript mounts for Bob 1 and Bob 2, env-configurable roots, hooks off, read-only root fs.
- `GET /stats` and `GET /stats/flat` (app/src/stats.ts, wired in app/src/server.ts): helpers running, per job / model / day tool calls, tokens and API-equivalent cost. Prices in `config/pricing.json` (`AGENT_FLOW_PRICING` override). Costs are labelled API-equivalent (Max plan is not billed per token).
- `scripts/ship-transcripts.sh`: rsync of Bob 2's transcripts to a Prodigy folder.
- `docs/ha/`: Home Assistant Build view, REST sensors, and the LifeOS proxy route spec (route itself belongs to the lifeos repo).
- Tests: app/src/stats.test.ts (cost maths, parsing, aggregation).
- README: "Deploy on Prodigy" and "Stats endpoint" sections.

### Rollback
`docker compose down`; revert this commit. No host config is modified.

### Files
docker-compose.yml, .env.example, .gitignore, Dockerfile, config/pricing.json, app/src/stats.ts, app/src/stats.test.ts, app/src/server.ts, scripts/ship-transcripts.sh, docs/ha/*, README.md, CHANGELOG.md

## Unreleased (metal-phoenix fork — 2026-11-17)

### Why

Security and privacy hardening based on a line-by-line audit of the patoles/agent-flow fork (see [docs/AUDIT-2026-11.md](docs/AUDIT-2026-11.md)). Addressed three critical findings: opt-out telemetry with a hardcoded third-party endpoint, unconditional `~/.claude/settings.json` hook installation on every run, and 64 dependency vulnerabilities (5 critical). Also added deployment configuration needed for multi-machine relay setups (e.g., reverse-proxy or container deployments).

### Security
- Telemetry completely removed — deleted all telemetry code (`scripts/telemetry.ts` and `scripts/telemetry/`) and its test suites, removed all wiring from app/src/server.ts and scripts/relay.ts. No more installation ID, no more `~/.agent-flow/telemetry/` directory, no more outbound calls to upstream telemetry endpoints
- Next.js built-in telemetry disabled via `NEXT_TELEMETRY_DISABLED=1` environment variable (set in web/package.json and root package.json dev/build scripts)
- Fixed dependency vulnerabilities (line-by-line audit):
  - Bumped `next` 16.1.6 → 16.4.6 and `vite` ^8.0.1 → ^8.3.8 in web/package.json
  - Added pnpm overrides pinning transitive `shell-quote` to >=1.9.0 and `sharp` to >=0.35.5
  - Result: `pnpm audit` reduced from 64 vulnerabilities (5 critical, 27 high) to 11 (0 critical, low-risk dev-only issues)

### Changed
- Claude Code hook installation is now opt-in instead of automatic
  - Pass `--setup-hooks` flag or set `AGENT_FLOW_SETUP_HOOKS=true` env var when running `npx agent-flow-app` / the bundled app to install hooks
  - Default behavior now tails transcript files directly (unchanged functionality, hooks were only a low-latency addition for permission-prompt detection)
  - Implemented in app/src/app.ts and app/src/args.ts
- Server bind address is now configurable
  - `--host <address>` CLI flag or `AGENT_FLOW_HOST` env var (defaults to `127.0.0.1`, no behavior change unless set)
  - When binding to non-loopback address (e.g., `0.0.0.0` in a container), set `AGENT_FLOW_ALLOWED_HOST` to the Host header your reverse proxy forwards — otherwise the server's DNS-rebinding guard rejects all requests
  - New function `isAllowedRequestHost()` in extension/src/request-guard.ts

### Added
- Added `AGENT_FLOW_ROOTS` environment variable — a comma-separated list of absolute paths to Claude Code transcript roots (e.g., `~/.claude/projects`), allowing one Agent Flow instance to watch transcripts from multiple machines (e.g., synced or NFS-mounted) instead of just the local one
  - Implemented via `resolveTranscriptRoots()` in extension/src/constants.ts, used by scripts/relay.ts
  - When unset, behavior unchanged (just the local `~/.claude/projects`)
- Dockerfile and .dockerignore for running the standalone server in a container (multi-stage, `node:22-slim`, runs as non-root `node` user)
  - Builds via existing `pnpm run build:app` (esbuild-bundled, no node_modules needed at runtime)
- New documentation:
  - `docs/AUDIT-2026-11.md` — line-by-line audit findings and security verdict
  - `docs/INTEGRATION-PLAN.md` — deployment plan for running Agent Flow in production

### Files Changed

- **Telemetry removal**: `scripts/telemetry.ts`, `scripts/telemetry/` (deleted), `app/src/server.ts`, `scripts/relay.ts`, `web/package.json`, `package.json`
- **Hook opt-in**: `app/src/app.ts`, `app/src/args.ts`
- **Configuration**: `extension/src/constants.ts`, `extension/src/request-guard.ts`, `app/src/server.ts`
- **Dependencies**: `web/package.json`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`
- **Deployment**: `Dockerfile`, `.dockerignore`
- **Documentation**: `docs/AUDIT-2026-11.md`, `docs/INTEGRATION-PLAN.md`, `README.md`, `CHANGELOG.md`

### How to Roll Back

1. **To undo all changes in this release**, revert the commit:
   ```bash
   git revert <commit-hash>
   pnpm i  # restore previous lock file
   ```

2. **To selectively restore telemetry** (not recommended), reset those specific files:
   ```bash
   git checkout HEAD~1 scripts/telemetry.ts scripts/telemetry/ app/src/server.ts scripts/relay.ts
   pnpm i
   ```

3. **To re-enable automatic hook installation** (not recommended):
   ```bash
   git checkout HEAD~1 app/src/app.ts app/src/args.ts
   # Then remove --setup-hooks flag or AGENT_FLOW_SETUP_HOOKS env var usage
   ```

4. **To restore older dependencies**, revert `web/package.json` and `pnpm-lock.yaml`:
   ```bash
   git checkout HEAD~1 web/package.json pnpm-lock.yaml
   pnpm i
   ```

## upstream versions

For upstream Agent Flow changelog entries, see [extension/CHANGELOG.md](extension/CHANGELOG.md).
