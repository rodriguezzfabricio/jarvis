set -eu
test "$(cat "$JARVIS_OUT/valid/code")" = 0
grep -q '^saved$' "$JARVIS_OUT/valid/stdout"
test "$(cat "$JARVIS_OUT/blank/code")" != 0
echo "JARVIS-CHECK-COMPLETE $(cat "$JARVIS_COMPLETION_FILE")"
