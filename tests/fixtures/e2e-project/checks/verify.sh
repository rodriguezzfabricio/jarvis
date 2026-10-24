#!/bin/sh
# Assertions for one check (decision 76): runs in the verify sandbox over $JARVIS_OUT only.
# Usage: verify.sh <case> [exit-only]. The case must have exited 0 and, unless exit-only, printed
# exactly $JARVIS_CHECKS/expected/<case>.txt. The last line proves the assertions ran to the end.
set -u
name="$1"
code="$(cat "$JARVIS_OUT/$name/code")"
if [ "$code" != 0 ]; then echo "case $name exited with: $code"; exit 1; fi
if [ "${2:-}" != exit-only ]; then
  if ! diff "$JARVIS_CHECKS/expected/$name.txt" "$JARVIS_OUT/$name/stdout"; then echo "case $name: observations differ"; exit 1; fi
fi
echo "JARVIS-CHECK-COMPLETE $(cat "$JARVIS_COMPLETION_FILE")"
