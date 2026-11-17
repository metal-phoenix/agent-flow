# Changelog

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
