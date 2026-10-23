import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** A temp dir under /tmp (short paths keep Unix socket names under macOS's 104-byte limit). */
export function shortTmp(prefix = "jt-"): string {
  const base = process.platform === "win32" ? tmpdir() : "/tmp";
  return mkdtempSync(join(realpathSync(base), prefix));
}

/** An executable that runs tests/fixtures/fake-claude.mjs with this Node, like a `claude` binary. */
export function fakeClaudeBin(dir: string): string {
  const fake = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}
