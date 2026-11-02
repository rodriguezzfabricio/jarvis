# AC1 and its argument, storage and failure contract.
set -eu
for c in reset add multiword special file default relative; do
  test "$(cat "$JARVIS_OUT/$c/code")" = 0
  test ! -s "$JARVIS_OUT/$c/stderr"
done
test ! -s "$JARVIS_OUT/reset/stdout"
for c in add multiword special; do
  printf 'saved\n' | cmp -s - "$JARVIS_OUT/$c/stdout"
done
printf '%s' '{"name":"exercise"}
{"name":"buy milk"}
{"name":"tea\t\"milk\"\\café later"}
' | cmp -s - "$JARVIS_OUT/file/stdout"
printf '%s' 'saved
saved
{"name":"exercise"}
{"name":"walk"}
' | cmp -s - "$JARVIS_OUT/default/stdout"
printf '%s' 'saved
{"name":"from-cwd"}
' | cmp -s - "$JARVIS_OUT/relative/stdout"
for c in refuse-blank refuse-missing refuse-newline refuse-cr; do
  test "$(cat "$JARVIS_OUT/$c/code")" = 1
  test ! -s "$JARVIS_OUT/$c/stdout"
  test -s "$JARVIS_OUT/$c/stderr"
done
for c in missing-command unknown-command; do
  test "$(cat "$JARVIS_OUT/$c/code")" = 2
  test ! -s "$JARVIS_OUT/$c/stdout"
  printf '%s' 'usage: node src/cli.mjs add <name> | list
' | cmp -s - "$JARVIS_OUT/$c/stderr"
done
test "$(cat "$JARVIS_OUT/write-error/code")" = 1
test ! -s "$JARVIS_OUT/write-error/stdout"
test -s "$JARVIS_OUT/write-error/stderr"
echo "JARVIS-CHECK-COMPLETE $(cat "$JARVIS_COMPLETION_FILE")"
