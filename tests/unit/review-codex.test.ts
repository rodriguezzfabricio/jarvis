import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCodexReviewer, codexEnvironment } from "../../packages/cli/src/review/codex.ts";
import type { ReviewerInput } from "../../packages/cli/src/review/types.ts";
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function setup(mode = "pass", version = "codex-cli 0.164.0") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "review-codex-"))); roots.push(root);
  const workspace = join(root, "checkout"); const outputDir = join(root, "output");
  mkdirSync(workspace); mkdirSync(outputDir);
  const bin = join(root, "fake-codex");
  const record = join(root, "calls.jsonl");
  writeFileSync(bin, `#!${process.execPath}\nimport {writeFileSync,appendFileSync,readFileSync} from 'node:fs';
const a=process.argv.slice(2); const val=f=>a[a.indexOf(f)+1];
appendFileSync(${JSON.stringify(record)},JSON.stringify({args:a,env:process.env,stdin:readFileSync(0,'utf8')})+'\\n');
if(a.includes('--version')) { console.log(${JSON.stringify(version)}); process.exit(0); }
const mode=${JSON.stringify(mode)};
if(mode==='timeout') { process.on('SIGTERM',()=>{ writeFileSync(val('-o'),JSON.stringify({findings:[]})); console.log(JSON.stringify({type:'turn.completed'})); process.exit(0); }); setInterval(()=>{},1000); }
else if(mode==='limit') { console.log(JSON.stringify({type:'error',message:"You've hit your usage limit"})); console.log(JSON.stringify({type:'turn.failed'})); process.exit(1); }
else if(mode==='unrelated') { console.log("You've hit your usage limit"); process.exit(2); }
else { writeFileSync(val('-o'), mode==='garbage'?'not-json':JSON.stringify({findings:[]})); console.log(JSON.stringify({type:mode==='failed'?'turn.failed':'turn.completed'})); }
`, { mode: 0o700 });
  const input: ReviewerInput = { workspace, outputDir, prompt: "review candidate", model: "gpt-6.1-sol", effort: "high", maxTurns: 10, timeoutMs: mode === "timeout" ? 150 : 5000 };
  return { root, input, bin, record, reviewer: createCodexReviewer({ home: root, binary: bin }) };
}
describe("isolated Codex reviewer", () => {
  it("uses exactly the four approved environment keys", () => {
    expect(codexEnvironment("/safe/home", "fake-user")).toEqual({ HOME: "/safe/home/.jarvis/codex-home/home", USER: "fake-user", PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin", CODEX_HOME: "/safe/home/.jarvis/codex-home" });
  });
  it("checks the exact version and launches read-only with ignored stdin and schema", async () => {
    const s = setup(); const result = await s.reviewer(s.input);
    expect(result.error).toBeUndefined();
    expect(result.rawVerdict).toBe('{"findings":[]}');
    expect(result.reviewer).toBe("codex");
    const calls = readFileSync(s.record, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(calls[0].args).toEqual(["--version"]);
    expect(calls[1].args).toEqual(["exec", "-C", s.input.workspace, "-m", "gpt-6.1-sol", "--sandbox", "read-only", "--ephemeral", "--json", "--skip-git-repo-check", "-c", "project_doc_max_bytes=0", "-c", 'model_reasoning_effort="high"', "--output-schema", join(s.input.outputDir, "schema.json"), "-o", join(s.input.outputDir, "verdict.json"), "--", "review candidate"]);
    const schema = JSON.parse(readFileSync(join(s.input.outputDir, "schema.json"), "utf8"));
    expect(schema.required).toEqual(["findings"]);
    expect(schema.properties.findings.items.required).toContain("confidence");
    for (const c of calls) {
      expect(Object.keys(c.env).filter((k) => k !== "__CF_USER_TEXT_ENCODING").sort()).toEqual(["CODEX_HOME", "HOME", "PATH", "USER"]);
      expect(c.stdin).toBe("");
    }
  });
  it("recognizes the usage limit sequence", async () => {
    const s = setup("limit");
    expect((await s.reviewer(s.input)).fallbackReason).toBe("usage_limit");
  });
  it.each(["garbage", "failed", "unrelated", "timeout"])("never offers fallback for %s", async (mode) => {
    const s = setup(mode); const r = await s.reviewer(s.input);
    expect(r.fallbackReason).toBeUndefined();
    if (mode !== "garbage") expect(r.error).toBeTruthy();
    else expect(r.rawVerdict).toBe("not-json");
  });
  it("falls back on a missing absolute binary", async () => {
    const s = setup(); const r = await createCodexReviewer({ home: s.root, binary: join(s.root, "missing") })(s.input);
    expect(r.fallbackReason).toBe("missing_binary");
  });
  it("falls back on a version mismatch before launching exec", async () => {
    const s = setup("pass", "codex-cli 0.163.0"); const r = await s.reviewer(s.input);
    expect(r.fallbackReason).toBe("version_mismatch");
    expect(readFileSync(s.record, "utf8").trim().split("\n")).toHaveLength(1);
  });
  it("refuses a PATH binary", () => expect(() => createCodexReviewer({ home: "/safe", binary: "codex" })).toThrow(/absolute/));
});
