#!/usr/bin/env bash
# Rebuild + (re)start Agent Flow and regenerate the SBOM. Use instead of a bare
# `docker compose up -d --build` so sbom/ and Argus's copy never go stale.
# Extra args go to docker compose (e.g. -f docker-compose.yml -f docker-compose.lan.yml: the override alone has no build).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
docker compose "$@" up -d --build
# SBOM failure must not take down a running deploy; report loudly instead.
SBOM_SKIP_BUILD=1 scripts/sbom.sh agent-flow:local || echo "rebuild.sh: WARNING: SBOM generation failed" >&2
