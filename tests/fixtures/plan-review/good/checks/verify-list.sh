# AC3: missing and zero-byte stores, exact order/characters, and errors without partial output.
set -eu
for c in reset missing-store empty-store first second special list default; do
  test "$(cat "$JARVIS_OUT/$c/code")" = 0
  test ! -s "$JARVIS_OUT/$c/stderr"
done
for c in reset missing-store empty-store; do test ! -s "$JARVIS_OUT/$c/stdout"; done
for c in first second special; do printf 'saved\n' | cmp -s - "$JARVIS_OUT/$c/stdout"; done
printf '%s' 'exercise
buy milk
tea	"milk"\café later
' | cmp -s - "$JARVIS_OUT/list/stdout"
printf '%s' 'exercise
exercise
' | cmp -s - "$JARVIS_OUT/default/stdout"
for c in read-error malformed shape-0 shape-1 shape-2 shape-3 shape-4 shape-5 shape-6 shape-7 shape-8; do
  test "$(cat "$JARVIS_OUT/$c/code")" = 1
  test ! -s "$JARVIS_OUT/$c/stdout"
  test -s "$JARVIS_OUT/$c/stderr"
done
test "$(cat "$JARVIS_OUT/extra/code")" = 2
test ! -s "$JARVIS_OUT/extra/stdout"
printf '%s' 'usage: node src/cli.mjs add <name> | list
' | cmp -s - "$JARVIS_OUT/extra/stderr"
echo "JARVIS-CHECK-COMPLETE $(cat "$JARVIS_COMPLETION_FILE")"
