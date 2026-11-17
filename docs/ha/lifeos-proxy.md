# LifeOS proxy route for Agent Flow (spec for follow-up job in the lifeos repo)

STATUS: UNTESTED. Written without live Home Assistant or LifeOS access. Nothing here has been verified against the lifeos codebase.

## Goal

Expose the Agent Flow web UI and its stats API through LifeOS so that:

- A browser can open `https://<lifeos-host>/agent-flow/` behind the existing LifeOS login.
- A Home Assistant Lovelace iframe (`docs/ha/build-dashboard.yaml`) can embed that UI.
- Home Assistant REST sensors (`docs/ha/agent-flow-sensors.yaml`) can poll `/agent-flow/stats/flat`.

## Upstream (Agent Flow)

- Upstream base: `http://agent-flow:3001` on the docker network.
- Agent Flow must bind an address reachable from the docker network. Its default bind is `127.0.0.1` (`AGENT_FLOW_HOST` overrides it). Confirm this in the lifeos compose setup.
- Agent Flow rejects requests whose `Host` header is not loopback or `AGENT_FLOW_ALLOWED_HOST`. The proxy must send `Host: <value of AGENT_FLOW_ALLOWED_HOST>`, for example `agent-flow:3001`.
- Routes the proxy must forward (after prefix strip):
  - `/` and static assets (`/index.js`, `/index.css`).
  - `/events`: Server-Sent Events.
  - `/stats`: full JSON. Accepts `?days=` (1 to 90, default 7).
  - `/stats/flat`: flat JSON with the keys HA sensors read. Keys: `helpers_running`, `helpers_running_opus`, `helpers_running_sonnet`, `helpers_running_haiku`, `jobs_running`, `tool_calls_today`, `tokens_today`, `cost_today_usd`, `cost_window_usd`, `window_days`, `cost_label`, `generated_at`.
- WebSocket: not needed.

## Route

- Match `/agent-flow/*` (ANY method). The stats routes are GET only upstream. Other methods can be rejected at the proxy.
- Strip the `/agent-flow` prefix. Example: `/agent-flow/stats/flat` becomes `/stats/flat` upstream.
- Forward `/events` with:
  - Proxy buffering off.
  - Gzip off for this route.
  - A long read timeout (hours, not the default).
  - Chunked passthrough flushed per event.

## Authentication

Check what LifeOS already supports before implementing. Do not add a new auth system.

- Browser and iframe: the existing LifeOS session cookie.
- HA REST sensors: either a long-lived bearer token or an allowed-IP rule. Use whichever LifeOS already supports. Confirm in the lifeos code. The bearer scheme is TBD. HA sends `Authorization: Bearer <TOKEN>` from `secrets.yaml`.
- Do not expose `/agent-flow/*` without auth. The stats reveal job names and activity.

## Base path problem

The web UI uses absolute asset and API paths (`/index.js`, `/index.css`, `/events`). Under `/agent-flow/` these resolve to the LifeOS root and break. Pick one:

1. Recommended: serve Agent Flow on a subdomain (for example `agent-flow.<lifeos-host>`). No path rewriting is needed. Check that the cookie and framing rules below still work cross-subdomain.
2. Fallback: rewrite HTML at the proxy. Inject `<base href="/agent-flow/">` into the document head, or rewrite absolute `/`-prefixed paths in HTML. Rewriting only HTML does not fix absolute paths inside JS. Verify `/events` and any fetch calls in the bundled JS.

## Framing (iframe) and cookies

- LifeOS must allow framing by the HA origin for this route only.
  - Remove `X-Frame-Options` for `/agent-flow/*`, or set it to permit the HA origin.
  - Set `Content-Security-Policy: frame-ancestors <ha-origin>` for this route. Do not loosen framing elsewhere.
- The session cookie must be sent in a third-party iframe context:
  - Preferred: HA and LifeOS are same-site, so `SameSite=Lax` works.
  - Otherwise: `SameSite=None; Secure`. Changing cookie attributes affects the whole LifeOS login, so review it first.

## Acceptance checklist

- [ ] `GET https://<lifeos-host>/agent-flow/` without a session returns a login redirect or 401, not the UI.
- [ ] With a valid session, the UI loads, including CSS and JS.
- [ ] `/agent-flow/events` streams events live (no buffering) and stays open for more than 5 minutes.
- [ ] `GET /agent-flow/stats` returns the full JSON with `costLabel`.
- [ ] `GET /agent-flow/stats/flat` returns the flat keys listed above.
- [ ] `GET /agent-flow/stats/flat` with the HA auth method (bearer or allowed IP) returns 200 from Home Assistant.
- [ ] Requests with a wrong `Host` reach Agent Flow with the `AGENT_FLOW_ALLOWED_HOST` value, not 403.
- [ ] The HA Lovelace iframe at `/build` renders the UI (no X-Frame-Options or frame-ancestors block in the browser console).
- [ ] Other LifeOS routes still send their original framing headers.
- [ ] HA sensors `sensor.agent_flow_*` update about every 30 seconds.
- [ ] Non-GET methods to `/agent-flow/stats*` are rejected.
