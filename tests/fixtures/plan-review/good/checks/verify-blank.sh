# AC2: a blank name (spaces only, or no argument at all) exits nonzero, never prints `saved`, and persists nothing:
# after both attempts the file is absent or empty (reset started from nothing).
set -eu
test "$(cat "$JARVIS_OUT/reset/code")" = 0
test "$(cat "$JARVIS_OUT/blank/code")" != 0
test "$(cat "$JARVIS_OUT/missing/code")" != 0
if grep -q saved "$JARVIS_OUT/blank/stdout" "$JARVIS_OUT/missing/stdout"; then exit 1; fi
test "$(cat "$JARVIS_OUT/file/code")" = 0
test ! -s "$JARVIS_OUT/file/stdout"
echo "JARVIS-CHECK-COMPLETE $(cat "$JARVIS_COMPLETION_FILE")"
