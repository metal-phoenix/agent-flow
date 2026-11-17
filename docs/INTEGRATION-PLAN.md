# Integration plan — metal-phoenix fork (not yet deployed)

This is a plan only. Nothing in this document has been deployed; no containers were
started, no reverse-proxy or Home Assistant config was touched, and no secrets were
accessed. It describes how to wire this fork into Scott's home setup once the
changes on this branch are reviewed and merged.

## Goal

One Agent Flow instance that watches Claude Code transcripts from two machines and
is reachable through LifeOS's existing reverse proxy and login, with a tab in Home
Assistant.

## Sources to watch

| Source | Path | How it reaches the Agent Flow container |
|---|---|---|
| Bob 1 (Builder container) | `~/builder/home/.claude/projects` on the **host** (bind-mounted into the Builder container as its `~/.claude/projects`) | Bind-mount that host path read-only into the Agent Flow container, e.g. `-v ~/builder/home/.claude/projects:/transcripts/bob1:ro` |
| Bob 2 (Alienware, WSL) | `~/.claude/projects` inside WSL on the Alienware box | Not natively reachable from a container on a different host. Two options: **(a)** NFS-export the WSL path (or a Windows share) and mount it on the host running Agent Flow, then bind-mount that into the container; **(b)** run a small sync (e.g. `rsync`/`syncthing`) from the WSL box to a path on the Agent Flow host. (a) gives live tailing; (b) adds sync lag but no network dependency at read time. Given NFS is already mentioned as available, prefer (a). |

Once both are reachable as local paths inside the container (e.g.
`/transcripts/bob1` and `/transcripts/bob2`), set:

```
AGENT_FLOW_ROOTS=/transcripts/bob1,/transcripts/bob2
```

This fork's `scripts/relay.ts` watches every path in that list; extra roots beyond
the first are scanned in full (no per-workspace filename matching), since they
belong to other machines and won't match this container's cwd encoding. See
`extension/src/constants.ts#resolveTranscriptRoots` and the multi-root code in
`scripts/relay.ts#scanForActiveSessions`.

## Container

- Build from the new root `Dockerfile` (multi-stage, `node:22-slim`, runs as the
  non-root `node` user, bundled via `pnpm run build:app` — no `node_modules` in the
  runtime image).
- Env vars to set:
  - `AGENT_FLOW_ROOTS` — as above.
  - `AGENT_FLOW_HOST=0.0.0.0` — so the reverse proxy (on the host or another
    container) can reach it; the image's own `CMD` already passes `--host 0.0.0.0`.
  - `AGENT_FLOW_ALLOWED_HOST=<whatever Host header the proxy forwards>` — required,
    or every proxied request gets rejected by the DNS-rebinding guard in
    `extension/src/request-guard.ts`. If LifeOS's proxy forwards the original
    external hostname, use that; if it rewrites Host to something internal
    (e.g. `agent-flow:3001`), use that instead. Confirm by checking the proxy's
    config or logging one rejected request's Host header.
  - Hooks stay off (`AGENT_FLOW_SETUP_HOOKS` unset) — the container only reads
    transcripts, it never needs to write into any host's `~/.claude/settings.json`.
  - Telemetry: nothing to set — it's removed outright in this fork.
- Mount transcript roots read-only (`:ro`) — Agent Flow only ever reads them.
- Port: container listens on 3001 (matches `DEFAULT_RELAY_PORT`); map/front however
  the reverse proxy expects.

## LifeOS reverse proxy

- Add a route for `/agent-flow` → the container's port 3001, behind LifeOS's
  existing login (no additional auth needed in Agent Flow itself — it has none,
  by design, for a loopback-only tool, so the proxy's login is the only gate
  once it's exposed beyond loopback).
- Confirm the proxy strips or rewrites the `/agent-flow` prefix correctly — the
  web UI's static assets are served from `/` by `app/src/static.ts`, so a
  path-prefixed reverse proxy needs to either rewrite paths or use a subdomain
  instead of a subpath, if sub-resource requests (`/index.js`, `/index.css`,
  `/events`) don't also get the prefix stripped.
- Set `AGENT_FLOW_ALLOWED_HOST` (above) to match.

## Home Assistant "Build" tab

- Add a Home Assistant **Webpage card** (iframe panel) pointing at
  `https://<lifeos-host>/agent-flow`, placed next to the existing Builder
  dashboard tab.
- Since the page sits behind LifeOS's login, the HA iframe will need either (a)
  a session that's already authenticated in the same browser, or (b) LifeOS to
  allow an embeddable/token-based bypass for the iframe's origin. This needs the
  LifeOS login flow's cookie/session scoping checked — not something this job can
  verify without access to that live service.

## Headless `claude -p --output-format stream-json` runs

Checked only by reading Claude Code's documented transcript behavior, not by
running a live headless session (out of scope for this job / no secrets
available): headless (`-p`) runs write the same JSONL transcript format to
`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` as interactive sessions —
the transcript writer isn't gated on an interactive TTY, it's the same event
logging path regardless of `--output-format`. That means `scripts/relay.ts`'s
transcript-tailing approach should pick up headless Bob 1 runs exactly like
interactive ones, **without needing hooks at all** — reinforcing why hooks are
now opt-in in this fork. The one thing to verify once this is actually deployed:
confirm Bob 1's headless runs are still writing into the *same* bind-mounted path
(`~/builder/home/.claude/projects`) and not some other `HOME`-relative path
inside the container, since headless automation sometimes runs under a
different `$HOME` than an interactive shell would.

## What's left (needs live access this job doesn't have)

- Actually building/pushing the container image and deploying it.
- Setting up the NFS export (or sync) from the Alienware WSL box.
- LifeOS reverse-proxy config and confirming cookie/session scoping for the HA
  iframe.
- Home Assistant dashboard edit.
- Verifying a real headless `claude -p` run's transcript path on Bob 1 end-to-end.
