#!/usr/bin/env bash
# Run on Bob 2's runner (Alienware WSL): push Claude Code transcripts to Prodigy.
# One-way, transcripts only. Usage: ship-transcripts.sh user@prodigy /srv/agent-flow/bob2-transcripts
# Schedule with cron (every minute) or a `while` loop in a systemd user service.
set -euo pipefail
dest_host="${1:?user@prodigy}"; dest_dir="${2:?remote dir}"
src="${CLAUDE_PROJECTS_DIR:-$HOME/.claude/projects}/"
exec rsync -a --include='*/' --include='*.jsonl' --exclude='*' -e ssh "$src" "$dest_host:$dest_dir/"
