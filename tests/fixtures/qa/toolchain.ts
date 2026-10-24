import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ChecksStore } from "../../../packages/cli/src/checks/store.ts";
import { Ledger } from "../../../packages/cli/src/ledger/ledger.ts";

export function fakeToolchain(project: string) {
  const store = new ChecksStore(project);
  const ledger = Ledger.open(project);
  const root = join(store.checksDir, "fixtures", "toolchain");
  mkdirSync(root, { recursive: true });
  const sources = {
    "playwright.cjs": "module.exports = {chromium: {launch: async (options) => ({trusted: true, options, close: async () => {}})}};",
    "chromium": "Fake browser binary; never executed.\n",
    "cli.cjs": "// Fake CLI; never spawned by unit tests.\n",
    "axe.js": "/* Fake axe; never loaded in a real browser. */",
    "playwright-package.json": JSON.stringify({ version: "1.58.0" }),
    "axe-package.json": JSON.stringify({ version: "4.10.3" }),
  };
  const files: Record<string, string> = {};
  for (const [path, content] of Object.entries(sources)) {
    writeFileSync(join(root, path), content);
    files[path] = createHash("sha256").update(content).digest("hex");
  }
  const manifest = {
    playwright: { module: "playwright.cjs", cli: "cli.cjs", executable: "chromium", package: "playwright-package.json", version: "1.58.0" },
    axe: { source: "axe.js", package: "axe-package.json", version: "4.10.3" }, files,
  };
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
  const browserDriver = join(store.checksDir, "fixtures", "browser.ts");
  writeFileSync(browserDriver, "// Fake driver; never spawned by unit tests.\n");
  store.approve(ledger, "test-only toolchain approved");
  return { toolchain: { root, store, ledger }, browserDriver, manifest };
}
