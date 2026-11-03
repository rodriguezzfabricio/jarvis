import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { vi } from "vitest";
import type { GateInput, GateResult } from "../../../packages/cli/src/checks/gate.ts";
import type { JarvisEvalOptions, RunLoopOptions } from "../../../packages/cli/src/eval/jarvis.ts";
import { safeGit } from "../../../packages/cli/src/eval/git.ts";
import { addTask, BUG_PROMPT, createEvalFixture, markerGate, type EvalFixture } from "../eval-jarvis-fixture.ts";
import { fakeToolchain } from "../../fixtures/qa/toolchain.ts";

/**
 * The eval arm's per-run design gate (decision 167): tasks/<id>/design-checks.json names the scanner and flow
 * plan, the served app and hash-pinned QA and Impeccable inputs; the runner installs them into this run's store
 * and captures the base revision's axe record before any session. The loop and the base gate are fakes here.
 */
export const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
export const PAGE = "http://127.0.0.1:1/jobs";
export const SIX = ["impeccable-source", "impeccable-url", "design-browser", "ai-tells", "token-lint", "design-md-lint"];

/** The served capture's stdout as the case prints it: URLs on the logical origin (served-design.ts). */
export function observation(target?: string) {
  const axe = {version:"4.10.3", violations: target ? [{id:"color-contrast",impact:"serious",nodes:[{target:[target]}]}] : [], incomplete:[]};
  const screenshot = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
  const pages = ([375,768,1440] as const).map(width => ({width,url:PAGE,accessibilityTree:"heading Jobs",screenshot}));
  return {kind:"design-browser",capture:{designId:"jobs",flows:[{id:"jobs",status:"pass"}],pages:pages.map(p=>({...p,flow:"jobs",screen:"jobs",visibleText:"Jobs"}))},
    web:[{kind:"qa-browser",url:PAGE,pages:pages.map(p=>({...p,axe,frameCount:1,frameIds:["top"],frames:[{id:"top",url:PAGE,loaderId:"1",axe}]}))}]};
}

/** A base gate that records runner evidence the way runGate does: the capture's stdout, hashed in its gate_result. */
export function baseGate(raw: unknown, status: "pass" | "fail" = "pass", calls: GateInput[] = []) {
  return async (input: GateInput): Promise<GateResult> => {
    calls.push(input);
    const evidenceDir = join(input.projectDir, "evidence", `base-${calls.length}`), file = "cases/capture/stdout", text = JSON.stringify(raw);
    mkdirSync(join(evidenceDir, "cases", "capture"), {recursive:true}); writeFileSync(join(evidenceDir, file), text);
    return {status, evidenceDir, entry: input.ledger.append({kind:"gate_result",actor:"runner",data:{check:input.check.name,revision:input.revision,status,evidence:{dir:evidenceDir,files:{[file]:sha(text)}}}})};
  };
}

export interface DesignGateSetup { lint?: boolean; declared?: boolean; qaSource?: string; engineFile?: string }
export function setupDesignGate(fixtures: EvalFixture[], { lint = true, declared = true, qaSource = "toolchains/qa/checks/fixtures/toolchain", engineFile = "toolchains/impeccable" }: DesignGateSetup = {}) {
  const f = createEvalFixture(); fixtures.push(f);
  const put = (file: string, text: string) => { const path = join(f.sourceRepo, file); mkdirSync(dirname(path), {recursive:true}); writeFileSync(path, text); };
  put("DESIGN.md", readFileSync(new URL("../../fixtures/qa/DESIGN.md", import.meta.url), "utf8").replace("## Overview", "## Overview\nPrinciples: Familiar controls, clear state."));
  put("PRODUCT.md", "A familiar job board."); put("app.html", "<main>Jobs</main>");
  const git = (args: string[]) => safeGit(f.sourceRepo, args, { home: f.home }).toString().trim();
  git(["add", "-A"]); git(["commit", "-qm", "design reference"]);
  const task = addTask(f, "05-citizenship", BUG_PROMPT, {rev:git(["rev-parse", "HEAD"])}), dir = join(f.evalsRepo, "tasks", task.id);
  const qa = fakeToolchain(join(f.evalsRepo, "toolchains", "qa"));
  writeFileSync(join(f.evalsRepo, "toolchains", "impeccable"), "fake engine");
  if (lint) writeFileSync(join(dir, "design-lint.json"), JSON.stringify({axeVersion:"4.10.3",designSource:"existing",files:["app.html"],tokenFiles:[]}));
  const declaration = {version:1,qa:{source:qaSource,manifestSha256:sha(readFileSync(join(qa.toolchain.root,"manifest.json")))},engine:{file:engineFile,version:"0.1.16",sha256:sha("fake engine")},
    scanner:{files:["app.html"],path:"/jobs"},plan:{designId:"jobs",flows:[{id:"jobs",screen:"jobs",url:"/jobs",steps:[],expectText:"Jobs"}]},app:{build:"fake build",serve:"fake serve",readyPath:"/jobs",timeoutMs:1000}};
  if (declared) writeFileSync(join(dir, "design-checks.json"), JSON.stringify(declaration));
  const runLoop = vi.fn(async (_loop: RunLoopOptions) => ({status:"complete" as const,done:[],blocked:[]}));
  const preflight = vi.fn(async () => ({ok:true}));
  const options: JarvisEvalOptions = {preflight,evalsRepo:f.evalsRepo,jarvisHome:f.jarvisHome,workRoot:f.workRoot,home:f.home,gate:markerGate().gate,
    harness:{runTask:async()=>{throw Error("unexpected session");}},runLoop,designGate:baseGate(observation(".old"))};
  return {f, task, qa, options, runLoop, preflight, gateDir: join(f.evalsRepo, "hidden", task.id, "gate"), grading: join(f.evalsRepo, "hidden", task.id, "checks")};
}

/** Every file below dir, as text; the QA bytes and the engine copy are included, so a path in any of them shows. */
export function texts(dir: string): string[] {
  return readdirSync(dir, {recursive:true, encoding:"utf8"}).map(name => join(dir, name)).filter(path => statSync(path).isFile()).map(path => readFileSync(path, "utf8"));
}
