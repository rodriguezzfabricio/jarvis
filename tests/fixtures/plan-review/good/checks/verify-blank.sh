# AC2: refusing invalid names preserves the existing item.
set -eu
for c in reset seed file; do
  test "$(cat "$JARVIS_OUT/$c/code")" = 0
  test ! -s "$JARVIS_OUT/$c/stderr"
done
test ! -s "$JARVIS_OUT/reset/stdout"
printf '%s' 'saved
' | cmp -s - "$JARVIS_OUT/seed/stdout"
for c in blank missing newline cr; do
  test "$(cat "$JARVIS_OUT/$c/code")" = 1
  test ! -s "$JARVIS_OUT/$c/stdout"
  printf 'item name must not be blank\n' | cmp -s - "$JARVIS_OUT/$c/stderr"
done
printf '%s' '{"name":"keep"}
' | cmp -s - "$JARVIS_OUT/file/stdout"
echo "JARVIS-CHECK-COMPLETE $(cat "$JARVIS_COMPLETION_FILE")"
