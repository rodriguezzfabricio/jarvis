import { createRequire } from "node:module";
import type { register } from "../../packages/cli/src/decisions/decide.ts";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { shortTmp } from "../helpers.ts";
import { DecisionRegister } from "../../packages/cli/src/decisions/store.ts";
import type { DecisionInput } from "../../packages/cli/src/decisions/format.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { projectId } from "../../packages/cli/src/config/project.ts";

const root = shortTmp("jdc-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const decideUrl = new URL("../../packages/cli/src/decisions/decide.ts", import.meta.url).href;
const commanderUrl = new URL("../../packages/cli/node_modules/commander/index.js", import.meta.url).href;
const script = `import { Command } from ${JSON.stringify(commanderUrl)};
import { register } from ${JSON.stringify(decideUrl)};
const program = new Command().name("jarvis"); register(program, { home: ${JSON.stringify(root)} });
await program.parseAsync(process.argv.slice(1), { from: "user" });`;
const { Command } = createRequire(new URL("../../packages/cli/package.json", import.meta.url))("commander") as { Command: new () => Parameters<typeof register>[0] };
const compileCache = join(root, "node-compile-cache");
let n = 0;
function repo() { const dir = join(root, `repo ${++n}`); mkdirSync(dir); mkdirSync(join(dir, ".git")); writeFileSync(join(dir, "evidence.md"), "# Evidence\n"); return dir; }
// A --by user write needs a recorded explicit intake answer (decisions/answer.ts), so each user write
// here first records a one-question round, the session's answer and its decision in a fixture ledger.
function run(dir: string, args: string[]) {
  const by = args.lastIndexOf("--by");
  const repoFlag = args.lastIndexOf("--repo");
  const target = repoFlag < 0 ? dir : resolve(dir, args[repoFlag + 1]!);
  const hasChoice = args.length % 2 === 1 && args.at(-1) !== "--help";
  if (hasChoice && (by < 0 || args[by + 1] === "user")) {
    const choice = args.at(-1)!;
    const ledger = Ledger.open(join(root, ".jarvis", "projects", projectId(target)));
    const round = ledger.entries().length + 1;
    const requestId = `fixture-${round}`;
    const supersedes = args.lastIndexOf("--supersedes");
    const question = supersedes < 0 ? "Which choice?" : `Replace D${args[supersedes + 1]!.replace(/^d/i, "")}?`;
    ledger.append({ kind: "notify", actor: "runner", data: { source: "intake", phase: "round", round, requestId,
      snapshot: { round, spec: "docs/spec/v1.md", summary: "Fixture", questions: [{ id: "Q1", topic: "scope", question, why: "Fixture",
        default: { answer: "Keep", reason: "Fixture" }, alternatives: ["Change"] }], mockups: [] } } });
    const intent = ledger.append({ kind: "notify", actor: "runner", data: { source: "notify", phase: "answer", requestId,
      intakeOwned: true, intakeBy: "session", intakeAnswers: { Q1: choice } } });
    ledger.append({ kind: "decision", actor: "runner", data: { source: "intake", round, requestId,
      answerSeq: intent.seq, questionId: "Q1", answer: choice, by: "user", confirmed: true } });
    args = [...args, "--answer", `${intent.seq}:Q1`];
  }
  return spawnSync(process.execPath, ["--input-type=module", "-e", script, "--", "decide", ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, NODE_COMPILE_CACHE: compileCache } });
}
const flags = ["--by", "user", "--class", "mechanical", "--source", "evidence.md", "--why", "Keep it simple"];
const input: DecisionInput = { date: "2026-01-01", decision: "Old rule", madeBy: "fabricio", source: "evidence.md", class: "Taste", reversibility: "easy", why: "Deliberate", alternatives: [], dependsOn: [] };
function read(dir: string) { return DecisionRegister.open(dir).read().entries; }

describe("jarvis decide (decisions 83, 85)", () => {
  it("registers the command and documents every flag", () => {
    const result = run(repo(), ["--help"]);
    expect(result.status).toBe(0);
    for (const flag of ["--by", "--class", "--source", "--why", "--repo", "--reversibility", "--alternatives", "--depends-on", "--supersedes", "--reason", "--answer", "--recorded-answer"]) expect(result.stdout).toContain(flag);
  });

  it("defaults to cwd, writes all settled defaults and prints only the new ID", () => {
    const dir = repo();
    const result = run(dir, [...flags, "Use SQLite"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("D1\n");
    expect(result.stderr).toBe("");
    expect(read(dir)[0]).toMatchObject({ id: 1, decision: "Use SQLite", madeBy: "fabricio", class: "Mechanical", source: "evidence.md", why: expect.stringMatching(/^Keep it simple\nRecorded user answer: [1-9]\d*:Q1$/), reversibility: "reversible", alternatives: [], dependsOn: [] });
    expect(read(dir)[0]?.date).toBe(new Date().toISOString().slice(0, 10));
    expect(run(dir, [...flags, "Another choice"]).stdout).toBe("D2\n");
  });

  it.each([["user", "fabricio"], ["default-accepted", "accepted-default"], ["default-unconfirmed", "unconfirmed-default"], ["jarvis", "jarvis"]])("maps --by %s to %s", (by, madeBy) => {
    const dir = repo();
    expect(run(dir, [...flags, "--by", by!, "Choice"]).status).toBe(0);
    expect(read(dir)[0]?.madeBy).toBe(madeBy);
  });

  it.each([["mechanical", "Mechanical"], ["taste", "Taste"], ["challenge", "Challenge"]])("maps --class %s to %s", (kind, stored) => {
    const dir = repo();
    expect(run(dir, [...flags, "--class", kind!, "Choice"]).status).toBe(0);
    expect(read(dir)[0]?.class).toBe(stored);
  });

  it("honors --repo, source anchors, reversibility, alternatives and dependencies", () => {
    const dir = repo();
    const cwd = repo();
    const result = run(cwd, [...flags, "--repo", dir, "--source", "evidence.md#chosen", "--reversibility", "hard", "--alternatives", '["A | B","C"]', "--depends-on", '["S1","AC2"]', "Exact | choice\n✓"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("D1\n");
    expect(read(cwd)).toEqual([]);
    expect(read(dir)[0]).toMatchObject({ decision: "Exact | choice\n✓", source: "evidence.md#chosen", reversibility: "hard", alternatives: ["A | B", "C"], dependsOn: ["S1", "AC2"] });
    expect(run(dir, [...flags, "--alternatives", "-", "--depends-on", "-", "Explicit defaults"]).status).toBe(0);
    expect(read(dir)[1]).toMatchObject({ alternatives: [], dependsOn: [] });
  });

  describe("alternatives on decisions that are hard to undo (decision 171)", () => {
    const jarvis = ["--by", "jarvis", "--class", "mechanical", "--source", "evidence.md", "--why", "Keep it simple"];
    it.each(["moderate", "hard", "irreversible"])("refuses a %s jarvis decision with no alternatives and writes nothing", (level) => {
      const dir = repo();
      const result = run(dir, [...jarvis, "--reversibility", level, "Use SQLite"]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("needs at least one alternative, each as '<option>: rejected because <reason>'");
      expect(existsSync(join(dir, "docs", "decisions.md"))).toBe(false);
    });
    it.each(['["Postgres"]', '["Postgres: rejected because"]', '["Postgres: rejected because no"]', '["Postgres: rejected because it needs a server to run", "Files"]'])("refuses an alternative without a rejection reason: %s", (alternatives) => {
      const dir = repo();
      expect(run(dir, [...jarvis, "--reversibility", "hard", "--alternatives", alternatives, "Use SQLite"]).status).not.toBe(0);
      expect(existsSync(join(dir, "docs", "decisions.md"))).toBe(false);
    });
    it("accepts alternatives in the '<option>: rejected because <reason>' form", () => {
      const dir = repo();
      const result = run(dir, [...jarvis, "--reversibility", "hard", "--alternatives", '["Postgres: rejected because it needs a server the user would have to run", "JSON files: rejected because concurrent writes corrupt them"]', "Use SQLite"]);
      expect(result.status, result.stderr).toBe(0);
      expect(read(dir)[0]?.alternatives).toHaveLength(2);
    });
    it("reversible and easy decisions, and the user's own answers, need none", () => {
      const dir = repo();
      expect(run(dir, [...jarvis, "Use SQLite"]).status).toBe(0);
      expect(run(dir, [...jarvis, "--reversibility", "easy", "Use SQLite again"]).status).toBe(0);
      expect(run(dir, [...flags, "--reversibility", "irreversible", "Delete the old table"]).status).toBe(0);
      expect(read(dir)).toHaveLength(3);
    });
  });

  it.each(["--by", "--class", "--source", "--why"])("requires %s and never writes on refusal", (flag) => {
    const dir = repo();
    const index = flags.indexOf(flag);
    const args = flags.filter((_value, i) => i !== index && i !== index + 1);
    const result = run(dir, [...args, "Choice"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(flag);
    expect(existsSync(join(dir, "docs/decisions.md"))).toBe(false);
  });

  it("requires the decision argument", () => {
    const result = run(repo(), flags);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing required argument");
  });

  it.each([["--by", "inferred"], ["--by", "fabricio"], ["--class", "Taste"], ["--class", "other"], ["--reversibility", "nope"], ["--why", " "]])("refuses invalid %s %j", (flag, value) => {
    const dir = repo();
    const result = run(dir, [...flags, flag!, value!, "Choice"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/by|class|reversibility|why/i);
    expect(existsSync(join(dir, "docs/decisions.md"))).toBe(false);
  });

  it.each(["--alternatives", "--depends-on"])("validates %s as '-' or a JSON array of nonblank strings", (flag) => {
    const dir = repo();
    for (const value of ["plain text", "{}", "[1]", '[" "]', "["]) {
      const result = run(dir, [...flags, flag, value, "Choice"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(flag);
      expect(result.stdout).toBe("");
    }
    expect(read(dir)).toEqual([]);
  });

  it.each(["D1", "1"])("supersedes %s with user authorship, a date, a reason and reciprocal history", (id) => {
    const dir = repo();
    DecisionRegister.open(dir).add(input);
    const result = run(dir, [...flags, "--supersedes", id, "--reason", "I changed direction", "New rule"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("D2\n");
    expect(read(dir)[0]?.status).toMatchObject({ kind: "superseded", by: 2, reason: "I changed direction", date: read(dir)[1]?.date });
    expect(read(dir)[1]).toMatchObject({ supersedes: 1, decision: "New rule", madeBy: "fabricio" });
  });

  it("refuses missing/orphan reasons, malformed or unknown IDs, and non-user changes to firm decisions", () => {
    const dir = repo();
    DecisionRegister.open(dir).add(input);
    const before = readFileSync(join(dir, "docs/decisions.md"), "utf8");
    for (const extra of [["--supersedes", "1"], ["--reason", "orphan"], ["--supersedes", "0", "--reason", "x"], ["--supersedes", "1x", "--reason", "x"], ["--supersedes", "99", "--reason", "x"], ["--supersedes", "1", "--reason", " "] , ["--by", "jarvis", "--supersedes", "1", "--reason", "My idea"]]) {
      const result = run(dir, [...flags, ...extra, "New rule"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/reason|supersedes|not found|user|fabricio/i);
      expect(result.stdout).toBe("");
      expect(readFileSync(join(dir, "docs/decisions.md"), "utf8")).toBe(before);
    }
  });

  it("allows a reasoned Jarvis revision of its own call", () => {
    const dir = repo();
    DecisionRegister.open(dir).add({ ...input, madeBy: "jarvis" });
    expect(run(dir, [...flags, "--by", "jarvis", "--supersedes", "1", "--reason", "New evidence", "New rule"]).stdout).toBe("D2\n");
    expect(read(dir)[1]?.madeBy).toBe("jarvis");
  });

  it("refuses unsafe, missing and escaped source paths", () => {
    const dir = repo();
    const outside = join(root, "outside.md"); writeFileSync(outside, "outside");
    symlinkSync(outside, join(dir, "escape.md"));
    for (const source of [outside, "../outside.md", "a/../evidence.md", "./evidence.md", "evidence.md\n", "missing.md", "escape.md"]) {
      const result = run(dir, [...flags, "--source", source, "Choice"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/source/i);
      expect(result.stdout).toBe("");
    }
    expect(read(dir)).toEqual([]);
  });
});

// The same fault applies to a child CLI through NODE_OPTIONS and to the former in-process harness.
it("exposes an uncaught command failure with its stack instead of normalizing it", () => {
  const dir = repo();
  const hook = join(root, "throw-command-error.mjs");
  const commanderUrl = new URL("../../packages/cli/node_modules/commander/index.js", import.meta.url).href;
  writeFileSync(hook, `import { Command } from ${JSON.stringify(commanderUrl)};
Command.prototype.error = function uncaughtCommandFault() { throw new Error("synthetic uncaught command failure"); };
`);
  const before = process.env.NODE_OPTIONS;
  const mock = vi.spyOn(Command.prototype, "error").mockImplementation(function uncaughtCommandFault(): never { throw new Error("synthetic uncaught command failure"); });
  process.env.NODE_OPTIONS = `--import=${hook}`;
  try {
    const result = run(dir, []);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("synthetic uncaught command failure");
    expect(result.stderr).toContain("at Command.uncaughtCommandFault");
  } finally {
    mock.mockRestore();
    if (before === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = before;
  }
});

it("reports malformed rows without an uncaught stack or a register write", () => {
  const dir = repo();
  mkdirSync(join(dir, "docs"));
  const path = join(dir, "docs", "decisions.md");
  writeFileSync(path, "broken\n");
  const result = run(dir, ["--by", "jarvis", ...flags.slice(2), "New decision"]);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(/line 1:/i);
  expect(result.stderr).not.toContain("at parseRegister");
  expect(readFileSync(path, "utf8")).toBe("broken\n");
});
