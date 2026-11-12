#!/usr/bin/env bash
# Stands in for `hub` in tests: it records the argv of every call, answers the lane-start contract with ok for a spec
# whose lane key starts with ok-, and refuses every other lane with the hub's error reply and exit 1.
set -u
: "${FAKE_HUB_LOG:?FAKE_HUB_LOG must name the file the argv is recorded to}"
printf '%s\n' "$*" >>"$FAKE_HUB_LOG"
spec=""
previous=""
for arg in "$@"; do
  if [ "$previous" = "--spec" ]; then spec="$arg"; fi
  previous="$arg"
done
key="$(basename "$spec" .json)"
case "$key" in
  ok-*) printf '{"ok":true,"key":"%s","status":"starting"}\n' "$key"; exit 0 ;;
  *)
    printf '{"ok":false,"error":"hub refused lane %s: quota exhausted"}\n' "${key:-unknown}"
    exit 1
    ;;
esac
