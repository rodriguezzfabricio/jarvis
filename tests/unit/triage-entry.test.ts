import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { shortTmp } from "../helpers.ts";

// ENTRY-POINT SMOKE TEST. It runs the real `jarvis` entry point, so it needs the integrator's line in
// cli.ts (`registerTriage(program)`, from ./triage/command.ts). It fails on the triage lane's branch
// until that line is merged; /jarvis can't work without it.
const cli = fileURLToPath(new URL("../../packages/cli/src/cli.ts", import.meta.url));
const root = shortTmp("jttre-");
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("jarvis triage entry point (needs registerTriage in cli.ts)", () => {
  it("node packages/cli/src/cli.ts triage --json classifies a request", () => {
    const repo = join(root, "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    const r = spawnSync(process.execPath, [cli, "triage", "--json", "Build fails on CI"], { cwd: repo, encoding: "utf8", timeout: 15_000 });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const t = JSON.parse(r.stdout) as { type: string; decidedBy: string; folder: { empty: boolean } };
    expect(t.type).toBe("bug");
    expect(t.decidedBy).toBe("text");
    expect(t.folder.empty).toBe(false);
  });
});
