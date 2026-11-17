# Agent Flow (metal-phoenix fork) — standalone visualizer server.
#
# Builds the npx-style bundle (app/build.js: Vite webview + esbuild app
# bundle) and runs it as a non-root user. The runtime image needs nothing
# but the bundle — esbuild inlines all dependencies into app/dist/app.js.
#
# Mount the Claude Code transcript root(s) you want to watch read-only and
# point AGENT_FLOW_ROOTS at them (see README.md#metal-phoenix-fork).

FROM node:22-slim AS builder
WORKDIR /build
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY app/package.json app/package.json
COPY extension/package.json extension/package.json
COPY web/package.json web/package.json
RUN pnpm install --frozen-lockfile

COPY . .
RUN NEXT_TELEMETRY_DISABLED=1 pnpm run build:app

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Loopback by default even inside the container; override to 0.0.0.0 to
# accept connections from outside it (e.g. behind a reverse proxy), and set
# AGENT_FLOW_ALLOWED_HOST to the Host header the proxy forwards.
ENV AGENT_FLOW_HOST=127.0.0.1

COPY --from=builder /build/app/dist ./app/dist
COPY config /app/config

# node:*-slim images ship an unprivileged "node" user (uid 1000) already.
USER node
EXPOSE 3001

ENTRYPOINT ["node", "app/dist/app.js"]
CMD ["--host", "0.0.0.0"]
