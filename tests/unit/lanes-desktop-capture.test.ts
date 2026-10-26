import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { captureDesktopBundle } from "../../packages/cli/src/lanes/desktop-artifact.ts";

vi.mock("node:fs", async (original) => ({ ...await original<typeof fs>() }));

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "qa-capture-"))); roots.push(root);
  const checkout = join(root, "checkout"); const bundle = join(checkout, "target", "Test.app");
  fs.mkdirSync(join(bundle, "Contents"), { recursive: true }); fs.writeFileSync(join(bundle, "Contents", "Info.plist"), "fake plist");
  const outside = join(root, "outside.app"); fs.mkdirSync(outside); fs.writeFileSync(join(outside, "private"), "outside-private-data");
  const output = join(root, "output"); fs.mkdirSync(output);
  return { root, checkout, bundle, outside, output };
}

it("captures a built bundle as independent files", () => {
  const s = setup();
  expect(Object.keys(captureDesktopBundle(s.checkout, "target/Test.app", s.output).files)).toEqual(["Contents/Info.plist"]);
});

// Backlog 89: the capture checks containment, then materializeTree resolves the bundle again. A bundle swapped
// for an outside link in between must be refused by the copier's own approved-root check.
it("refuses a bundle swapped for an outside link after the capture's own containment check", () => {
  const s = setup(); const real = fs.realpathSync; let calls = 0;
  vi.spyOn(fs, "realpathSync").mockImplementation(((path: fs.PathLike, options?: never) => {
    if (path === s.bundle && ++calls === 2) { fs.renameSync(s.bundle, join(s.root, "saved.app")); fs.symlinkSync(s.outside, s.bundle); }
    return real(path, options);
  }) as typeof fs.realpathSync);
  expect(() => captureDesktopBundle(s.checkout, "target/Test.app", s.output)).toThrow(/approved|escapes/);
  expect(calls).toBeGreaterThanOrEqual(2);
  expect(fs.existsSync(join(s.output, "Test.app"))).toBe(false);
});
