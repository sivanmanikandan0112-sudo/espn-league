#!/bin/sh
# Stores the ESPN login cookies from ../.env as secrets on the League HQ live worker.
# The values are piped straight from the file and never printed.
set -e
cd "$(dirname "$0")"
grep '^ESPN_S2=' ../.env | cut -d= -f2- | npx wrangler secret put ESPN_S2
grep '^ESPN_SWID=' ../.env | cut -d= -f2- | npx wrangler secret put ESPN_SWID
echo "Done. Both ESPN cookies are stored on the worker."
