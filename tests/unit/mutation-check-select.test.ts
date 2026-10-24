import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script without types
import { buildGraph, collectedFiles, controlCache, idsForFiles, isCandidateTest, judge, relatedTests } from "../../scripts/mutation-select.mjs";

// The mutation check runs each mutation against the test files that can observe the mutated file,
// then the whole suite whenever that subset doesn't catch it. These pin the parts that keep the
// shortcut sound: a missed test may only cost a full-suite re-run, never a false "caught".

const repo = (files: Record<string, string>) => {
  const read = (p: string) => files[p];
  return { paths: Object.keys(files), graph: buildGraph(Object.keys(files), read) };
};

describe("mutation test selection", () => {
  const r = repo({
    "packages/cli/src/a.ts": 'import { b } from "./b.ts";\nexport const a = b;',
    "packages/cli/src/b.ts": 'export { c } from "./sub/c.ts";\nexport const b = 1;',
    "packages/cli/src/sub/c.ts": "export const c = 2;",
    "packages/cli/src/cli.ts": 'import { a } from "./a.ts";\nconst m = await import("./lazy.ts");',
    "packages/cli/src/lazy.ts": "export const lazy = 1;",
    "packages/cli/src/alone.ts": "export const alone = 1;",
    "packages/cli/src/store.ts": "export const store = 1;",
    "plugin/hooks/tripwire.mjs": "process.exit(0);",
    "skills/build/SKILL.md": "# Build\nSee templates/spec.md and packages/cli/src/alone.ts.",
    "templates/spec.md": "# Spec",
    "tests/helpers.ts": 'export const fake = join(root, "tests/fixtures/fake-claude.mjs");',
    "tests/fixtures/fake-claude.mjs": 'import "../../packages/cli/src/sub/c.ts";\nconst hooks = JSON.parse(readFileSync(`${pluginDir}/hooks/hooks.json`, "utf8"));',
    "plugin/hooks/hooks.json": '{ "hooks": { "SessionStart": [{ "hooks": [{ "command": "node plugin/hooks/start.mjs" }] }] } }',
    "plugin/hooks/start.mjs": "process.exit(0);",
    "package.json": '{ "scripts": { "jarvis": "node packages/cli/src/lazy.ts" } }',
    "tests/unit/pkg.test.ts": 'writeFileSync(join(dir, "package.json"), "{}");',
    "tests/unit/a.test.ts": 'import { a } from "../../packages/cli/src/a.ts";',
    "tests/unit/hook.test.ts": 'const hook = join(repo, "plugin", "hooks", "tripwire.mjs");',
    "tests/unit/cli.test.ts": 'spawnSync(process.execPath, ["packages/cli/src/cli.ts", "doctor"]);',
    "tests/unit/skill.test.ts": "const text = readFileSync(`${skillsDir}${name}/SKILL.md`, 'utf8');",
    "tests/unit/fake.test.ts": 'import { fake } from "../helpers.ts";',
    "tests/unit/other.test.ts": 'import { x } from "./not-a-file.ts"; const s = "mystore.ts tripwire.mjsx";',
    "tests/unit/skills-mutations.test.ts": 'const t = readFileSync("skills/build/SKILL.md"); import "../../packages/cli/src/a.ts";',
  });
  const tests = r.paths.filter(isCandidateTest);
  const related = (f: string) => relatedTests(f, r.graph, tests);

  it("treats only tests/unit test files as candidates, never the anchor-applicability *-mutations tests", () => {
    expect(isCandidateTest("tests/unit/a.test.ts")).toBe(true);
    expect(isCandidateTest("tests/unit/deep/x.test.ts")).toBe(true);
    expect(isCandidateTest("tests/unit/skills-mutations.test.ts")).toBe(false);
    expect(isCandidateTest("tests/unit/skills-build-mutations.test.ts")).toBe(false);
    expect(isCandidateTest("tests/unit/skills-mutations.json")).toBe(false);
    expect(isCandidateTest("tests/live/probe.test.ts")).toBe(false);
    expect(isCandidateTest("tests/helpers.ts")).toBe(false);
  });

  it("follows static imports, re-exports and literal dynamic imports transitively", () => {
    expect(related("packages/cli/src/a.ts")).toEqual(["tests/unit/a.test.ts", "tests/unit/cli.test.ts"]);
    expect(related("packages/cli/src/sub/c.ts")).toEqual(["tests/unit/a.test.ts", "tests/unit/cli.test.ts", "tests/unit/fake.test.ts"]);
    expect(related("packages/cli/src/lazy.ts")).toEqual(["tests/unit/cli.test.ts"]);
  });

  it("follows files a test spawns or reads by path or basename, and what those files import", () => {
    expect(related("plugin/hooks/tripwire.mjs")).toEqual(["tests/unit/hook.test.ts"]);
    expect(related("skills/build/SKILL.md")).toEqual(["tests/unit/skill.test.ts"]);
    // cli.test.ts spawns cli.ts as a subprocess: everything cli.ts imports can change its result.
    expect(related("packages/cli/src/b.ts")).toEqual(["tests/unit/a.test.ts", "tests/unit/cli.test.ts"]);
    // helpers.ts names the fake claude, which imports c.ts.
    expect(related("tests/fixtures/fake-claude.mjs")).toEqual(["tests/unit/fake.test.ts"]);
    // ...and the fake claude runs the SessionStart commands hooks.json names.
    expect(related("plugin/hooks/start.mjs")).toEqual(["tests/unit/fake.test.ts"]);
  });

  it("does not follow references out of markdown or package.json, nor partial-name matches", () => {
    // SKILL.md names alone.ts and templates/spec.md, but reading a markdown file doesn't run what it names.
    expect(related("packages/cli/src/alone.ts")).toEqual([]);
    expect(related("templates/spec.md")).toEqual([]);
    // pkg.test.ts names a package.json, but only a package manager runs its scripts.
    expect(related("package.json")).toEqual(["tests/unit/pkg.test.ts"]);
    expect(related("packages/cli/src/lazy.ts")).toEqual(["tests/unit/cli.test.ts"]);
    // "mystore.ts" and "tripwire.mjsx" are other names, so other.test.ts is not related to them.
    expect(related("plugin/hooks/tripwire.mjs")).not.toContain("tests/unit/other.test.ts");
    expect(related("packages/cli/src/store.ts")).toEqual([]);
  });

  it("never selects the anchor-applicability tests, even when they import or name the file", () => {
    expect(related("packages/cli/src/a.ts")).not.toContain("tests/unit/skills-mutations.test.ts");
    expect(related("skills/build/SKILL.md")).not.toContain("tests/unit/skills-mutations.test.ts");
  });

  it("ignores whole-line comments and type-only imports, which can't make code depend on a file", () => {
    const g = repo({
      "packages/cli/src/gate.ts": "export type Gate = {};\nexport const gate = 1;",
      "packages/cli/src/srt.ts": "export const srt = 1;",
      "packages/cli/src/used.ts": "export const used = 1;",
      "packages/cli/src/kept.ts": "export const kept = 1;",
      "tests/unit/comment.test.ts": "// see packages/cli/src/srt.ts\n/**\n * Pinned in srt.ts.\n */\nconst x = 1;",
      "tests/unit/types.test.ts": 'import type { Gate } from "../../packages/cli/src/gate.ts";\nexport type T = Gate;',
      "tests/unit/mixed.test.ts": 'import { type Gate, gate } from "../../packages/cli/src/gate.ts";',
      "tests/unit/after.test.ts": '/* inline */ import { used } from "../../packages/cli/src/used.ts";\nconst url = "https://x.test/a"; // kept.ts\nrun("kept.ts");',
    });
    const t = g.paths.filter(isCandidateTest);
    expect(relatedTests("packages/cli/src/srt.ts", g.graph, t)).toEqual([]);
    expect(relatedTests("packages/cli/src/gate.ts", g.graph, t)).toEqual(["tests/unit/mixed.test.ts"]);
    expect(relatedTests("packages/cli/src/used.ts", g.graph, t)).toEqual(["tests/unit/after.test.ts"]);
    expect(relatedTests("packages/cli/src/kept.ts", g.graph, t)).toEqual(["tests/unit/after.test.ts"]);
  });

  it("resolves a relative import to its one file, not to every file of that basename", () => {
    const g = repo({
      "packages/cli/src/checks/store.ts": "export const s = 1;",
      "packages/cli/src/decisions/store.ts": "export const d = 1;",
      "tests/unit/checks.test.ts": 'import { s } from "../../packages/cli/src/checks/store.ts";',
      "tests/unit/named.test.ts": 'import { s } from "../../packages/cli/src/checks/store.ts";\nrun(join(dir, "store.ts"));',
      "tests/unit/broken.test.ts": 'import { s } from "./store.ts";',
    });
    const t = g.paths.filter(isCandidateTest);
    expect(relatedTests("packages/cli/src/checks/store.ts", g.graph, t)).toEqual(["tests/unit/broken.test.ts", "tests/unit/checks.test.ts", "tests/unit/named.test.ts"]);
    // named.test.ts also names a "store.ts" outside its import, and broken.test.ts's import doesn't resolve: both stay related.
    expect(relatedTests("packages/cli/src/decisions/store.ts", g.graph, t)).toEqual(["tests/unit/broken.test.ts", "tests/unit/named.test.ts"]);
  });

  it("adds Vitest's import-graph answer, minus anything that isn't a candidate", () => {
    expect(related("packages/cli/src/alone.ts")).toEqual([]);
    expect(relatedTests("packages/cli/src/alone.ts", r.graph, tests, ["tests/unit/other.test.ts", "tests/unit/skills-mutations.test.ts", "tests/integration/e2e.test.ts"])).toEqual(["tests/unit/other.test.ts"]);
    expect(relatedTests("packages/cli/src/a.ts", r.graph, tests, ["tests/unit/a.test.ts"])).toEqual(["tests/unit/a.test.ts", "tests/unit/cli.test.ts"]);
  });

  it("selects a mutated test file itself", () => {
    expect(related("tests/unit/a.test.ts")).toEqual(["tests/unit/a.test.ts"]);
  });
});

describe("collected test files and ids", () => {
  const report = (names: string[]) => ({ testResults: names.map((n) => ({ name: `/tmp/jarvis-mut-x/repo/${n}`, assertionResults: [] })) });
  it("lists the repo-relative files a report ran, sorted", () => {
    expect(collectedFiles(report(["tests/unit/b.test.ts", "tests/unit/a.test.ts"]), "/tmp/jarvis-mut-x/repo")).toEqual(["tests/unit/a.test.ts", "tests/unit/b.test.ts"]);
  });
  it("picks the full control's ids that belong to a set of files, by whole file name", () => {
    const ids = ["unit/a.test.ts > s one", "unit/a.test.ts > s two", "unit/b.test.ts > s x", "unit/xa.test.ts > s y", "unit/a.test.tsx > s z"];
    expect(idsForFiles(ids, ["tests/unit/a.test.ts"])).toEqual(["unit/a.test.ts > s one", "unit/a.test.ts > s two"]);
    expect(idsForFiles(ids, ["tests/unit/a.test.ts", "tests/unit/b.test.ts"])).toEqual(ids.slice(0, 3));
  });
});

describe("per-set control cache", () => {
  it("runs the control once per distinct test set, whatever the order of the files", () => {
    const calls: unknown[][] = [];
    const get = controlCache((files: string[], clone: string) => {
      calls.push([files, clone]);
      return { ids: files.map((f) => `${f} > t`) };
    });
    const first = get(["tests/unit/b.test.ts", "tests/unit/a.test.ts"], "/w/repo-1");
    const again = get(["tests/unit/a.test.ts", "tests/unit/b.test.ts"], "/w/repo-2");
    get(["tests/unit/a.test.ts"], "/w/repo-2");
    expect(calls).toEqual([[["tests/unit/a.test.ts", "tests/unit/b.test.ts"], "/w/repo-1"], [["tests/unit/a.test.ts"], "/w/repo-2"]]);
    expect(again).toBe(first);
  });

  it("remembers an unusable control too, without re-running it", () => {
    let n = 0;
    const get = controlCache(() => {
      n++;
      return undefined;
    });
    expect(get(["tests/unit/a.test.ts"])).toBeUndefined();
    expect(get(["tests/unit/a.test.ts"])).toBeUndefined();
    expect(n).toBe(1);
  });

  it("shares one pending control between concurrent jobs", async () => {
    let n = 0;
    const get = controlCache(async (files: string[]) => (n++, await Promise.resolve({ ids: files })));
    const [a, b] = await Promise.all([get(["tests/unit/a.test.ts"]), get(["tests/unit/a.test.ts"])]);
    expect(a).toBe(b);
    expect(n).toBe(1);
  });
});

describe("subset verdict with full-suite fallback", () => {
  const v = (kind: string, detail = kind) => ({ kind, detail });
  const fake = async (subset: { kind: string; detail: string } | undefined, full: { kind: string; detail: string }, control: object | null = { ids: ["x"] }) => {
    const calls: string[] = [];
    const out = await judge({
      tests: subset === undefined ? [] : ["tests/unit/a.test.ts", "tests/unit/b.test.ts"],
      control: () => (calls.push("control"), control),
      runSubset: () => (calls.push("subset"), subset),
      runFull: async () => (calls.push("full"), full),
    });
    return { out, calls };
  };

  it("keeps a subset catch without running the full suite", async () => {
    const { out, calls } = await fake(v("caught", "1 failing assertion(s): t"), v("error"));
    expect(out).toEqual({ kind: "caught", detail: "1 failing assertion(s): t", scope: "2 of the suite's test files" });
    expect(calls).toEqual(["control", "subset"]);
  });

  it("re-runs a subset survivor on the full suite and reports the full suite's verdict", async () => {
    expect((await fake(v("survived"), v("survived"))).out).toEqual({ kind: "survived", detail: "survived", scope: "full suite, after 2 test files survived" });
    const { out, calls } = await fake(v("survived"), v("caught", "1 failing assertion(s): u"));
    expect(out).toEqual({ kind: "caught", detail: "1 failing assertion(s): u", scope: "full suite, after 2 test files survived" });
    expect(calls).toEqual(["control", "subset", "full"]);
  });

  it("re-runs a subset error on the full suite too, so only the full suite can turn it into a catch", async () => {
    expect((await fake(v("error", "1 test(s) timed out"), v("error", "x"))).out).toEqual({ kind: "error", detail: "x", scope: "full suite, after 2 test files gave an error" });
    expect((await fake(v("error"), v("caught"))).out.kind).toBe("caught");
  });

  it("goes straight to the full suite when no test file is related", async () => {
    const { out, calls } = await fake(undefined, v("survived"));
    expect(out).toEqual({ kind: "survived", detail: "survived", scope: "full suite, no related test file" });
    expect(calls).toEqual(["full"]);
  });

  it("goes straight to the full suite when the subset's own control isn't clean", async () => {
    const { out, calls } = await fake(v("caught"), v("survived"), null);
    expect(out).toEqual({ kind: "survived", detail: "survived", scope: "full suite, the 2 test files' control wasn't clean" });
    expect(calls).toEqual(["control", "full"]);
  });

  it("hands the subset run the subset's control", async () => {
    const seen: unknown[] = [];
    const control = { ids: ["tests/unit/a.test.ts > t"] };
    await judge({ tests: ["tests/unit/a.test.ts"], control: async () => control, runSubset: (tests: string[], c: unknown) => (seen.push(tests, c), v("caught")), runFull: () => v("error") });
    expect(seen).toEqual([["tests/unit/a.test.ts"], control]);
  });
});
