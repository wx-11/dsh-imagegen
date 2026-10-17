#!/usr/bin/env bash
set -euo pipefail
TARGET="${1:?target path required}"
ORIGINAL="${2:?original path required}"
cp -- "$ORIGINAL" "$TARGET"
cmp -- "$TARGET" "$ORIGINAL"
printf 'ROLLBACK OK: %s restored from %s\n' "$TARGET" "$ORIGINAL"
