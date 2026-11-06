#!/bin/sh
# smoke.sh <deliverable-dir> — idempotent validation (syntax gate + one headless load).
# One-time deps live at /home/qt/.local/share/sa-smoke; never npm install in your
# worktree, never download browsers (cached at ~/.cache/ms-playwright).
set -u
DIR="${1:?usage: scripts/smoke.sh <deliverable-dir>}"
DEPS="/home/qt/.local/share/sa-smoke"
HERE=$(cd "$(dirname "$0")" && pwd)
if [ ! -d "$DEPS/node_modules/playwright" ]; then
  echo "first run: installing smoke deps (one-time)..."
  mkdir -p "$DEPS"
  printf "%s\n" "{\"name\":\"sa-smoke\",\"private\":true}" > "$DEPS/package.json"
  (cd "$DEPS" && npm install playwright@1.64.1 --registry=https://registry.npmjs.org --no-fund --no-audit) \
    || { echo "SMOKE FAIL: dep install"; exit 2; }
fi
exec node "$HERE/smoke.js" "$DIR"
