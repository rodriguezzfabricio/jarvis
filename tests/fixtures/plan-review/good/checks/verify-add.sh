# AC1, A4 and A5: save trimmed and unquoted multiword names; both default-path branches use an isolated app.
set -eu
for c in reset add multiword file default; do test "$(cat "$JARVIS_OUT/$c/code")" = 0; done
for c in add multiword; do
  printf 'saved\n' | cmp -s - "$JARVIS_OUT/$c/stdout"
  test ! -s "$JARVIS_OUT/$c/stderr"
done
printf '{"name":"exercise"}\n{"name":"buy milk"}\n' | cmp -s - "$JARVIS_OUT/file/stdout"
printf 'saved\nsaved\n{"name":"exercise"}\n{"name":"walk"}\n' | cmp -s - "$JARVIS_OUT/default/stdout"
test ! -s "$JARVIS_OUT/default/stderr"
echo "JARVIS-CHECK-COMPLETE $(cat "$JARVIS_COMPLETION_FILE")"
