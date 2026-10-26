import { generateKeyPairSync } from "node:crypto";
import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { encodedCases, root, snapshotErrors } from "./helpers/snapshot-fixture.ts";

afterAll(() => rmSync(root, { recursive: true, force: true }), 120_000);

describe("sanitized snapshots (golden tasks: how every task runs)", () => {
  // Codex review 6, high: credentials encoded by their containing format, and credential-named fields.
  // The cases are split across snapshot-2 and snapshot-3 (helpers/snapshot-fixture.ts); this is the first half.
  it("refuses credentials hidden by JSON, YAML or percent encoding, and literal credential fields (first half)", async () => {
    const entries = encodedCases(generateKeyPairSync("ed25519"));
    const mine = entries.slice(0, Math.ceil(entries.length / 2));
    const errs = await snapshotErrors(mine);
    for (const [i, [name]] of mine.entries()) expect(errs[i], name).toContain(name);
  }, 120_000);
});
