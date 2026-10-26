// Shared fixture for the session tests (tests/unit/session-*.test.ts). Each test file gets its own
// folder (this module is evaluated once per test file) and removes it in its own afterAll.
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shortTmp } from "../../helpers.ts";

export const dir = shortTmp("jtss-");
// A child that prints 2,000 numbered lines and exits at once.
const bin = join(dir, "emit");
writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" -e 'for (let i = 1; i <= 2000; i++) console.log("line " + i)'\n`);
chmodSync(bin, 0o755);
export const base = { bin, args: [], cwd: dir, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 20_000 };
