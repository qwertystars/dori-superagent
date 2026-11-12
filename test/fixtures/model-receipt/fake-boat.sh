#!/bin/sh
# The stand-in for `boat exec`: prints a fixture session log for "exec <sandbox> -- <command>", and fails everything
# else, so a test proves the boat path without the real CLI. The sandbox id names the fixture to print.
dir=$(dirname "$0")
[ "$1" = "exec" ] || exit 1
case "$2" in
sbx-match) cat "$dir/match.jsonl" ;;
sbx-mismatch) cat "$dir/mismatch.jsonl" ;;
sbx-empty) exit 0 ;;
*) exit 1 ;;
esac
