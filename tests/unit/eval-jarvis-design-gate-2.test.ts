import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runJarvis } from "../../packages/cli/src/eval/jarvis.ts";
import type { GateInput } from "../../packages/cli/src/checks/gate.ts";
import type { EvalFixture } from "./eval-jarvis-fixture.ts";
import { baseGate, observation, PAGE, setupDesignGate } from "./helpers/eval-design-gate-fixture.ts";

// What the eval arm refuses around the per-run design gate (decision 167); the install is in eval-jarvis-design-gate-1.
const fixtures: EvalFixture[] = [];
afterEach(() => fixtures.splice(0).forEach(f => f.cleanup()));

it("lets both arms load the same pinned browser libraries", async () => {
  const s = setupDesignGate(fixtures);
  cpSync(s.qa.toolchain.root, join(s.grading, "fixtures", "browser-tools"), {recursive:true});
  await expect(runJarvis(s.task, s.options)).resolves.toMatchObject({designBaseline:"recorded"});
}, 60_000);

it("keeps every design file the runner installs outside its pinned runtimes disjoint from grading", async () => {
  // Here the flow plan, which the installers write as design-plan.json.
  const t = setupDesignGate(fixtures);
  writeFileSync(join(t.grading, "plan.json"), JSON.stringify({designId:"jobs",flows:[{id:"jobs",screen:"jobs",url:PAGE,steps:[],expectText:"Jobs"}]}));
  await expect(runJarvis(t.task, t.options)).rejects.toThrow(/grading files.*design-plan\.json/);
  expect(t.runLoop).not.toHaveBeenCalled();
}, 60_000);

it.each([
  ["a QA toolchain", {qaSource:"hidden/05-citizenship/checks/qa"}],
  ["an engine", {engineFile:"hidden/05-citizenship/gate/impeccable"}],
  ["a QA toolchain named in another letter case", {qaSource:"HIDDEN/05-citizenship/checks/qa"}],
])("refuses %s from the evals repo's hidden folder before the preflight", async (_label, knobs: {qaSource?: string; engineFile?: string}) => {
  const s = setupDesignGate(fixtures, knobs);
  cpSync(s.qa.toolchain.root, join(s.grading, "qa"), {recursive:true});
  writeFileSync(join(s.gateDir, "impeccable"), "fake engine");
  // Another letter case names the same folder only on a case-insensitive volume (macOS's default); elsewhere it is missing.
  if (knobs.qaSource?.startsWith("HIDDEN") && !existsSync(join(s.f.evalsRepo, "HIDDEN"))) return;
  await expect(runJarvis(s.task, s.options)).rejects.toThrow(/may not come from hidden/);
  expect(s.preflight).not.toHaveBeenCalled();
}, 60_000);

it("refuses design checks declared without design-lint.json before the preflight", async () => {
  const s = setupDesignGate(fixtures, {lint:false});
  await expect(runJarvis(s.task, s.options)).rejects.toThrow(/design-lint\.json/);
  expect(s.preflight).not.toHaveBeenCalled();
}, 60_000);

// Decision 125: only the runner's base capture makes a baseline. A hidden gate carrying the six definitions itself (the
// path before decision 167) would otherwise hand its own record to the design reviewer, which reads expected/axe-base.json.
it.each(["expected/axe-base.json", "Expected/AXE-base.json"])("refuses a hidden gate that ships the runner's axe baseline (%s) before any session", async file => {
  const s = setupDesignGate(fixtures, {declared:false}), calls: GateInput[] = [];
  writeFileSync(join(s.gateDir, "design-plan.json"), JSON.stringify({designId:"jobs",flows:[{id:"jobs",screen:"jobs",url:PAGE,steps:[],expectText:"Jobs"}]}));
  const definitions = Object.fromEntries(["impeccable-source", "impeccable-url", "design-browser"].map(name => [name, {name,cases:[{id:"scan",command:`approved ${name} case`}],verify:`approved ${name} verify`,timeoutMs:1000}]));
  writeFileSync(join(s.gateDir, "design-checks.json"), JSON.stringify(definitions));
  for (const [name, definition] of Object.entries(definitions)) writeFileSync(join(s.gateDir, `${name}.check.json`), JSON.stringify(definition));
  const path = join(s.gateDir, file);
  mkdirSync(dirname(path), {recursive:true}); writeFileSync(path, JSON.stringify({baseRevision:"a".repeat(40),axeVersion:"4.10.3",observation:observation(".old")}));
  await expect(runJarvis(s.task, {...s.options, designGate: baseGate(observation(".old"), "pass", calls)})).rejects.toThrow(/axe baseline/);
  expect(calls).toHaveLength(0); expect(s.runLoop).not.toHaveBeenCalled();
}, 60_000);
