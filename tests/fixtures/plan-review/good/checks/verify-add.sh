# AC1: a nonblank name is persisted and `saved` is printed. Every case is its own process; reset starts from nothing,
# so the file afterwards holds exactly the one item, as one JSON line (D2).
set -eu
test "$(cat "$JARVIS_OUT/reset/code")" = 0
test "$(cat "$JARVIS_OUT/add/code")" = 0
printf 'saved\n' | cmp -s - "$JARVIS_OUT/add/stdout"
test "$(cat "$JARVIS_OUT/file/code")" = 0
printf '{"name":"exercise"}\n' | cmp -s - "$JARVIS_OUT/file/stdout"
echo "JARVIS-CHECK-COMPLETE $(cat "$JARVIS_COMPLETION_FILE")"
