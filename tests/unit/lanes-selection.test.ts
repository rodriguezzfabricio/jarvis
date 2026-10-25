import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { selectLanes, type SelectionInput } from "../../packages/cli/src/lanes/selection.ts";

const commits = JSON.parse(readFileSync("tests/fixtures/qa/freehire-commits.json", "utf8")) as Record<string, string[]>;
const change = (path: string, added = 2, deleted = 1) => ({ path, added, deleted });
const select = (files: string[], type: SelectionInput["type"] = "feature", facts: SelectionInput["facts"] = {}) =>
  selectLanes({ changes: files.map(p => change(p)), type, facts });
const names = (input: ReturnType<typeof select>) => input.map(l => l.lane);

describe("lanes run only on what the change touches", () => {
  it("runs QA, API and security for a Go handler bug, without UI or architecture", () => {
    const result = select(["internal/handlers/jobs.go"], "bug", { dependencies: { svelte: "5" } });
    expect(names(result)).toEqual(["API", "Security", "QA"]);
    expect(result.find(l => l.lane === "API")?.checks).toEqual(["spectral", "oasdiff"]);
  });

  it("scopes a button fix to its one screen, even in a full stack repo", () => {
    const result = select(["web/src/routes/habits/+page.svelte"], "bug", {});
    expect(names(result)).toEqual(["UX/UI", "Security", "QA"]);
    expect(result[0]?.files).toEqual(["web/src/routes/habits/+page.svelte"]);
    expect(result[0]?.checks).toEqual(expect.arrayContaining(["ai-tells", "token-lint", "design-md-lint", "axe", "playwright"]));
    expect(result[0]?.checks).not.toContain("maestro");
  });

  const golden = [
    { task: 2, files: ["internal/outreach/handler.go", "internal/outreach/store.go", "migrations/003_drafts.sql", "web/src/routes/drafts/+page.svelte"], lanes: ["API", "Data", "UX/UI", "Security", "QA"] },
    { task: 3, files: commits["971efc2"]!, lanes: ["Security", "QA"] },
    { task: 4, files: commits["e29e084"]!, lanes: ["Security", "QA"] },
    { task: 5, files: commits["4f7e73a"]!, lanes: ["Security", "QA"] },
    { task: 6, files: commits["4fa1a40"]!, lanes: ["UX/UI", "Security", "QA"] },
    { task: 7, files: ["AGENTS.md", "docs/map.md"], lanes: ["QA"] },
    { task: 8, files: ["internal/budgets/handler.go", "migrations/004_budgets.sql"], lanes: ["API", "Data", "Security", "QA"] },
    { task: 9, files: ["mobile/app/drafts.tsx", "mobile/ios/App.swift"], lanes: ["UX/UI", "Security", "QA"] },
    { task: 10, files: ["internal/outreach/status.go", "web/src/lib/Status.svelte"], lanes: ["UX/UI", "Security", "QA"] },
    { task: 11, files: ["src/App.tsx", "package.json", "migrations/001_habits.sql"], lanes: ["Architecture", "Data", "UX/UI", "Security", "QA"] },
    { task: 12, files: ["src/App.tsx", "src-tauri/src/main.rs"], lanes: ["Architecture", "UX/UI", "Security", "QA"] },
  ];
  it.each(golden)("covers golden task $task", ({ task, files, lanes }) => {
    const result = select(files, task >= 11 ? "new-product" : task === 4 || task === 5 ? "bug" : "feature", { dependencies: task === 9 ? { expo: "54" } : {} });
    expect(names(result)).toEqual(lanes);
    if (task === 9) expect(result.find(l => l.lane === "UX/UI")?.checks).toContain("maestro");
    if (task === 12) expect(result.find(l => l.lane === "UX/UI")?.checks).toContain("native-smoke");
  });

  it("uses diff stats to require deleted-test review and never skips a deletion", () => {
    const result = selectLanes({ type: "bug", facts: {}, changes: [change("tests/auth.test.ts", 0, 30)] });
    expect(result.find(l => l.lane === "QA")?.checks).toEqual(expect.arrayContaining(["protected-checks", "test-integrity"]));
    expect(names(result)).not.toContain("UX/UI");
  });

  it("selects architecture for refactors and changed dependency boundaries", () => {
    expect(names(select(["src/util.ts"], "refactor"))).toContain("Architecture");
    expect(names(select(["package.json"]))).toContain("Architecture");
  });

  it("selects performance only for touched performance areas or explicit measured work", () => {
    expect(names(select(["src/cache/jobs.ts"]))).toContain("Performance");
    expect(names(select(["src/Button.tsx"]))).not.toContain("Performance");
    expect(names(selectLanes({ changes: [change("src/sort.ts")], type: "bug", facts: { performanceFiles: ["src/sort.ts"] } }))).toContain("Performance");
  });

  it("does not make repository facts alone activate lanes, and is deterministic", () => {
    expect(select([], "new-product", { webRoots: ["web"], iosRoots: ["ios"] })).toEqual([]);
    const input = { changes: [change("src/api/jobs.ts"), change("src/App.tsx"), change("src/App.tsx")], type: "feature" as const, facts: {} };
    const before = JSON.stringify(input);
    expect(selectLanes(input)).toEqual(selectLanes({ ...input, changes: [...input.changes].reverse() }));
    expect(JSON.stringify(input)).toBe(before);
    expect(selectLanes(input).find(l => l.lane === "UX/UI")?.files).toEqual(["src/App.tsx"]);
  });

  it("does not select lanes for question/review pipelines, but accepts explicit follow-on edits", () => {
    expect(select(["src/App.tsx"], "question")).toEqual([]);
    expect(select(["internal/handlers/jobs.go"], "review")).toEqual([]);
    expect(names(select(["src/App.tsx"], "feature"))).toContain("QA");
  });

  it("rejects traversal and bad diff stats rather than silently dropping changes", () => {
    for (const path of ["../secrets", "/tmp/file", "src/../file", "C:\\temp\\file", "src/./file"]) {
      expect(() => select([path])).toThrow();
    }
    expect(() => selectLanes({ type: "bug", facts: {}, changes: [change("src/a.ts", -1)] })).toThrow();
  });

  it("considers both ends of a rename and mixed web/native changes", () => {
    const result = selectLanes({ type: "feature", facts: { dependencies: { expo: "54" } }, changes: [
      { ...change("src/util.ts"), oldPath: "src/api/jobs.ts" }, change("web/src/App.tsx"), change("mobile/app/Card.tsx"),
    ] });
    expect(names(result)).toContain("API");
    expect(result.find(l => l.lane === "UX/UI")?.checks).toEqual(expect.arrayContaining(["playwright", "maestro"]));
  });

  it("keeps UI helpers and UI fixtures covered alongside API routes", () => {
    const result = select(["src/routes/api/jobs/+server.ts", "tests/fixtures/Card.tsx", "web/src/lib/jobs.ts"], "bug", { dependencies: { svelte: "5" } });
    expect(names(result)).toEqual(["API", "UX/UI", "Security", "QA"]);
  });

  it("checks the design contract when DESIGN.md itself changes", () => {
    const result = select(["DESIGN.md"], "feature", {});
    expect(names(result)).toEqual(["UX/UI", "QA"]);
    expect(result.find(l => l.lane === "UX/UI")?.checks).toContain("design-md-lint");
    expect(result.find(l => l.lane === "UX/UI")?.checks).not.toContain("playwright");
  });
});
