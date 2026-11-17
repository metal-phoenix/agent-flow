# LifeOS proxy route for Agent Flow (spec for a follow-up job in the lifeos repo)

Nothing here is implemented or tested. Agent Flow has no auth of its own and publishes no host port; LifeOS's login is the only gate.

## Route
- `ANY /agent-flow/*` → `http://agent-flow:3001/*` (docker network `lifeos`, strip the `/agent-flow` prefix).
- Behind the **existing LifeOS login** (session cookie for browser/iframe). For HA REST sensors (`/agent-flow/stats/flat`, `/agent-flow/stats`) use whichever non-browser auth LifeOS already supports (bearer token or allowed IP); check the lifeos repo first.
- Send `Host: agent-flow:3001` upstream (must equal `AGENT_FLOW_ALLOWED_HOST`).
- `/events` is Server-Sent Events: disable proxy buffering and gzip, long read timeout (>1h), no response caching.
- The UI uses absolute asset paths (`/index.js`, `/index.css`, `/events`). Either serve on a subdomain (recommended) or rewrite the HTML/`<base href="/agent-flow/">` and paths.

## Iframe from Home Assistant
- Allow framing by the HA origin on this route (CSP `frame-ancestors <ha-origin>`; drop `X-Frame-Options`).
- Session cookie must be sent in the iframe: same site as HA, or `SameSite=None; Secure`.

## Acceptance checklist
- [ ] Logged-out request to `/agent-flow/` redirects to login.
- [ ] Logged-in UI loads with live events (SSE streaming, not buffered).
- [ ] `/agent-flow/stats/flat` returns JSON to HA with the chosen auth.
- [ ] HA Build view iframe renders; sensors in `agent-flow-sensors.yaml` populate.
- [ ] No host port published by the agent-flow container.
