import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PlanSchema } from "../../packages/cli/src/runner/plan.ts";
import { ResolutionFileSchema } from "../../packages/cli/src/review/plan-resolve.ts";

/** The Goldfish decision layer in the skills and the command (decisions 170 to 172, handoff B8 and B9). */
const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const prose = (text: string) => text.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/^```[^\n]*\n[\s\S]*?^```/gm, "");
const section = (text: string, name: string) => prose(text).split(`## ${name}\n`)[1]?.split(/^## /m)[0] ?? "";

describe("the Goldfish decision layer in the skills", () => {
  it("the architect's resolution example is one the runner's resolve command accepts, and names the four actions once each", () => {
    const text = read("skills/architect/SKILL.md").split("## Goldfish review\n")[1]!.split(/^## /m)[0]!;
    const fences = [...text.matchAll(/^```json\n([\s\S]*?)^```/gm)];
    expect(fences).toHaveLength(1);
    const parsed = ResolutionFileSchema.parse(JSON.parse(fences[0]![1]!.replace("<from findings.json>", "a".repeat(64))));
    expect(parsed.resolutions.map((r) => r.action).sort()).toEqual(["contest", "decline", "escalate", "fix"]);
  });
  it("the architect's plan example still passes the runner's schema", () => {
    const plan = read("skills/architect/SKILL.md").split("## Write the plan\n")[1]!.split(/^## /m)[0]!;
    const fence = /^```json\n([\s\S]*?)^```/m.exec(plan)!;
    expect(() => PlanSchema.parse(JSON.parse(fence[1]!.replace("<triage’s tier>", "1")))).not.toThrow();
  });
  it("the spec reader's findings get the same four actions, and padding the spec for a reviewer is ruled out", () => {
    const text = section(read("skills/spec/SKILL.md"), "Check with a fresh reader");
    for (const phrase of ["decision 172", "fix the draft", "contest it citing a file or decision", "never \"intentional\"", "escalate", "never pad the spec", "decline nits", "Spec check vN"]) expect(text, phrase).toContain(phrase);
    expect(text).not.toContain("Fix each gap in the draft, or record why not");
    expect(Buffer.byteLength(read("skills/spec/SKILL.md"))).toBeLessThan(20 * 1024);
  });
  it("/jarvis says the plan is reviewed before the runner (the command stays under its cap, so the skills hold the commands)", () => {
    const body = read("plugin/commands/jarvis.md");
    for (const phrase of ["decision 170", "three fresh read-only lenses", "by evidence, fix or escalation", "refuses a plan without a counted review"]) expect(body, phrase).toContain(phrase);
    expect(body.indexOf("decision 170")).toBeLessThan(body.indexOf("`jarvis run --detach`"));
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(4500);
  });
  it("the architect evals include a plan that left a choice to the builder, resolved as a decision with alternatives", () => {
    const data = JSON.parse(read("evals/skills/architect/evals.json")) as { evals: { prompt: string; expectations: string[] }[] };
    const eval13 = data.evals.find((e) => e.prompt.includes("Zero-Decision Rule"));
    expect(eval13).toBeDefined();
    expect(eval13!.expectations.join("\n")).toMatch(/--alternatives/);
    expect(eval13!.expectations.join("\n")).toMatch(/jarvis plan review/);
  });
  it("the negative-control fixtures plant the three faults the calibration must name", () => {
    const bad = JSON.parse(read("tests/fixtures/plan-review/bad/plan.json")) as { tasks: { id: string; goal: string }[] };
    const good = JSON.parse(read("tests/fixtures/plan-review/good/plan.json")) as { tasks: { id: string; goal: string }[] };
    expect(() => PlanSchema.parse(bad)).not.toThrow(); expect(() => PlanSchema.parse(good)).not.toThrow();
    expect(bad.tasks.find((t) => t.id === "T2")!.goal).toContain("src/retry.mjs");
    expect(existsSync(new URL("tests/fixtures/plan-review/bad/repo/src/util/retry.mjs", root))).toBe(true);
    expect(bad.tasks.find((t) => t.id === "T3")!.goal).toMatch(/pick a storage format/i);
    expect(read("tests/fixtures/plan-review/bad/repo/docs/decisions.md")).toMatch(/\| D3 \|.*\| hard \|.*\| \[\] \|/);
    expect(good.tasks.find((t) => t.id === "T2")!.goal).toContain("src/util/retry.mjs");
    expect(good.tasks.find((t) => t.id === "T3")!.goal).toContain("data/items.jsonl");
    expect(read("tests/fixtures/plan-review/good/repo/docs/decisions.md")).toMatch(/\| D3 \|.*\| hard \|.*rejected because/);
    for (const fixture of ["bad", "good"]) for (const file of ["spec.md", "checks/item-create.check.json", "checks/item-list.check.json", "repo/docs/spec/v1.md", "repo/.gitignore"]) expect(existsSync(new URL(`tests/fixtures/plan-review/${fixture}/${file}`, root)), `${fixture}/${file}`).toBe(true);
  });
  it("the docs carry decisions 170 to 172, the harness assumption, the backlog rows and the getting-started commands", () => {
    const decisions = read("docs/01-decisions.md");
    for (const heading of ["### 170. The Goldfish plan review", "### 171. Engineering decisions of moderate or harder reversibility require rejected alternatives", "### 172. Plan-review findings are resolved by contest, fix, escalate or decline"]) expect(decisions).toContain(heading);
    expect(read("docs/harness-assumptions.md")).toContain("context and tool isolation, not filesystem isolation");
    expect(read("docs/backlog.md")).toMatch(/^\| 230 \| Decision 170/m);
    const started = read("docs/getting-started.md");
    expect(started).toContain("`jarvis plan review"); expect(started).toContain("jarvis plan resolve"); expect(started).toContain("does not count and the run is refused");
    expect(read("packages/cli/src/decisions/README.md")).toContain("rejected because");
  });
});
