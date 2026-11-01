set -eu
test "$(cat "$JARVIS_OUT/add/code")" = 0
test "$(cat "$JARVIS_OUT/list/code")" = 0
grep -q '^exercise$' "$JARVIS_OUT/list/stdout"
echo "JARVIS-CHECK-COMPLETE $(cat "$JARVIS_COMPLETION_FILE")"
