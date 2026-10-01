#!/usr/bin/env bash
# Launch the Simkl stdio MCP server. stdout = JSON-RPC only; logs go to stderr.
# Resolves its own directory, so it works from any cwd / install location.
# Env files (later wins): <plugin root>/.env.local, then $PLUGIN_DATA/.env.local when PLUGIN_DATA is set.
# The server persists tokens to $PLUGIN_DATA/.env.local when set, else <plugin root>/.env.local.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
cd "$ROOT/server"
set -a
for f in "$ROOT/.env.local" "${PLUGIN_DATA:+$PLUGIN_DATA/.env.local}"; do
  if [[ -n "$f" && -f "$f" ]]; then
    # shellcheck disable=SC1090
    source "$f"
  fi
done
set +a
exec node index.js
