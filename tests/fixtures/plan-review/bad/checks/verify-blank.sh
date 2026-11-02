# AC2: all four invalid names produce the specified error and leave the store empty or absent.
set -eu
test "$(cat "$JARVIS_OUT/reset/code")" = 0
for c in blank missing newline cr; do
  test "$(cat "$JARVIS_OUT/$c/code")" = 1
  test ! -s "$JARVIS_OUT/$c/stdout"
  printf 'item name must not be blank\n' | cmp -s - "$JARVIS_OUT/$c/stderr"
done
test "$(cat "$JARVIS_OUT/file/code")" = 0
test ! -s "$JARVIS_OUT/file/stdout"
echo "JARVIS-CHECK-COMPLETE $(cat "$JARVIS_COMPLETION_FILE")"
