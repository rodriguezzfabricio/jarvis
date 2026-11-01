# AC2: a blank name (spaces only, no argument at all, or a line break inside the name, spec A2) exits nonzero, never
# prints `saved`, and persists nothing: after all three attempts the file is absent or empty (reset started from nothing).
set -eu
test "$(cat "$JARVIS_OUT/reset/code")" = 0
for c in blank missing newline; do test "$(cat "$JARVIS_OUT/$c/code")" != 0; done
if grep -q saved "$JARVIS_OUT/blank/stdout" "$JARVIS_OUT/missing/stdout" "$JARVIS_OUT/newline/stdout"; then exit 1; fi
test "$(cat "$JARVIS_OUT/file/code")" = 0
test ! -s "$JARVIS_OUT/file/stdout"
echo "JARVIS-CHECK-COMPLETE $(cat "$JARVIS_COMPLETION_FILE")"
