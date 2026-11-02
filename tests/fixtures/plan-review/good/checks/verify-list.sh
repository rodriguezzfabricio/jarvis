# AC3, A4 and A6: list preserves order, resolves its default independently of cwd, and reports real read/parse errors.
set -eu
for c in reset empty first second list default; do test "$(cat "$JARVIS_OUT/$c/code")" = 0; done
test ! -s "$JARVIS_OUT/empty/stdout"
printf 'exercise\nbuy milk\n' | cmp -s - "$JARVIS_OUT/list/stdout"
printf 'exercise\nexercise\n' | cmp -s - "$JARVIS_OUT/default/stdout"
for c in read-error malformed; do
  test "$(cat "$JARVIS_OUT/$c/code")" = 1
  test ! -s "$JARVIS_OUT/$c/stdout"
  test -s "$JARVIS_OUT/$c/stderr"
done
test "$(cat "$JARVIS_OUT/extra/code")" = 2
test ! -s "$JARVIS_OUT/extra/stdout"
printf 'usage: node src/cli.mjs add <name> | list\n' | cmp -s - "$JARVIS_OUT/extra/stderr"
echo "JARVIS-CHECK-COMPLETE $(cat "$JARVIS_COMPLETION_FILE")"
