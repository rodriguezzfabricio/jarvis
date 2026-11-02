import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { COMPLETE, gate, project, root } from "./helpers/checks-fixture.ts";

afterAll(() => rmSync(root, { recursive: true, force: true }));

it("runs cases in order in one checkout and gives the verifier captured observations and its protected inputs", async () => {
  const p = project();
  writeFileSync(join(p.store.checksDir, "expected"), "42\n");
  writeFileSync(join(p.store.checksDir, "verify.sh"), `set -eu
for id in seed read; do
  test "$(cat "$JARVIS_OUT/$id/code")" = 0
  cmp "$JARVIS_CHECKS/expected" "$JARVIS_OUT/$id/stdout"
  test ! -s "$JARVIS_OUT/$id/stderr"
done
${COMPLETE}`);
  p.store.approve(p.ledger, "case contract");
  const result = await gate(p, {
    name: "case-contract",
    cases: [
      { id: "seed", command: "cat value.txt; cp value.txt sequence.txt" },
      { id: "read", command: "cat sequence.txt" },
    ],
    verify: 'sh "$JARVIS_CHECKS/verify.sh"',
    timeoutMs: 30_000,
  });
  expect(result.status).toBe("pass");
  expect(result.entry.data).toMatchObject({ completed: true, verifyExitCode: 0,
    caseResults: [{ id: "seed", code: 0 }, { id: "read", code: 0 }] });
});
