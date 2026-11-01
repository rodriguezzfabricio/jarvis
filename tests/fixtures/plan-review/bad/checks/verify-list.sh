# AC3: `list` in a new process (every case is its own process) prints every saved item, one per line, in the order
# saved; with nothing saved it prints nothing and still exits 0.
set -eu
for c in reset empty first second list; do test "$(cat "$JARVIS_OUT/$c/code")" = 0; done
test ! -s "$JARVIS_OUT/empty/stdout"
printf 'exercise\nbuy milk\n' | cmp -s - "$JARVIS_OUT/list/stdout"
echo "JARVIS-CHECK-COMPLETE $(cat "$JARVIS_COMPLETION_FILE")"
