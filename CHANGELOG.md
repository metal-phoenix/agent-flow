# Changelog

## Unreleased (metal-phoenix fork — 2026-11-17)

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

## upstream versions

For upstream Agent Flow changelog entries, see [extension/CHANGELOG.md](extension/CHANGELOG.md).
