import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyQaToolchain } from "../../packages/cli/src/lanes/toolchain.ts";
import { fakeToolchain } from "../fixtures/qa/toolchain.ts";
const roots: string[] = [];
const temp = () => { const root = mkdtempSync(join(tmpdir(), "qa-links-")); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe("installed QA toolchains remain symlink-free", () => {
  it.each(["chromium", "/tmp", "missing", "alias"])("rejects an installed link to %s", target => {
    const fixture = fakeToolchain(temp()); const path = join(fixture.toolchain.root, "manifest.json");
    symlinkSync(target, join(fixture.toolchain.root, "alias"));
    const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
    expect(() => verifyQaToolchain(path, hash, temp())).toThrow(/symlink/);
    expect(() => fixture.toolchain.store.approve(fixture.toolchain.ledger, "must refuse links")).toThrow(/symlink/);
  });
});
