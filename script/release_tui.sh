#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if ! command -v bun >/dev/null 2>&1; then
  echo "The release cockpit needs Bun 1.3 or later: https://bun.sh" >&2
  exit 1
fi
exec bun "$ROOT_DIR/bin/cli.js" "$@"
