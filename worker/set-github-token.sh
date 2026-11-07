#!/bin/sh
# Stores a GitHub token as the worker's GITHUB_TOKEN secret, so the worker can trigger the full site refresh
# every 30 minutes. Run this first, then copy the token on GitHub: it watches the clipboard for up to
# 3 minutes and picks the token up as soon as it's copied. The token is never printed.
cd "$(dirname "$0")" || exit 1
looks_like_token() { case "$1" in github_pat_*|ghp_*) return 0 ;; *) return 1 ;; esac; }

TOKEN=$(pbpaste | tr -d '[:space:]')
if ! looks_like_token "$TOKEN"; then
  echo "Waiting for you to copy the token on GitHub (the copy button next to github_pat_...)."
  i=0
  while [ $i -lt 90 ]; do
    sleep 2
    TOKEN=$(pbpaste | tr -d '[:space:]')
    looks_like_token "$TOKEN" && break
    i=$((i + 1))
  done
fi
if ! looks_like_token "$TOKEN"; then
  echo "No GitHub token showed up on the clipboard in 3 minutes. Copy it on GitHub, then run this again."
  exit 1
fi
echo "Got it. Saving the token to the worker..."
printf '%s' "$TOKEN" | npx wrangler secret put GITHUB_TOKEN || exit 1
printf '' | pbcopy  # clear the clipboard so the token isn't pasted somewhere by accident
echo "Done. The worker can now start the full refresh every 30 minutes."
