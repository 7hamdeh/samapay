#!/usr/bin/env bash
# THE ONLY SUPPORTED WAY TO RUN A SCRIPT AGAINST THE SANDBOX DATABASE.
# Parses ONE key from .env.sandbox — never sources it (a value with a space
# would execute). Usage: pnpm verify:sandbox scripts/verify-x.ts
set -euo pipefail
[ -f .env.sandbox ] || { echo "No .env.sandbox found." >&2; exit 1; }
url="$(grep -E '^DATABASE_URL=' .env.sandbox | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')"
[ -n "$url" ] || { echo ".env.sandbox has no DATABASE_URL" >&2; exit 1; }
case "$url" in *_sandbox*) ;; *) echo "REFUSING: .env.sandbox DATABASE_URL does not name a *_sandbox database" >&2; exit 1;; esac
DATABASE_URL="$url" exec pnpm exec tsx "$@"
