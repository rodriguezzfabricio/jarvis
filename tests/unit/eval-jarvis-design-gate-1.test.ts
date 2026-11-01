import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runJarvis } from "../../packages/cli/src/eval/jarvis.ts";
import type { GateInput } from "../../packages/cli/src/checks/gate.ts";
import { ChecksStore } from "../../packages/cli/src/checks/store.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { readDesignBaseline } from "../../packages/cli/src/lanes/design-gate.ts";
import type { EvalFixture } from "./eval-jarvis-fixture.ts";
import { baseGate, observation, setupDesignGate, SIX, texts } from "./helpers/eval-design-gate-fixture.ts";

// The install and the base capture (decision 167); refusals are in eval-jarvis-design-gate-2.test.ts.
const fixtures: EvalFixture[] = [];
afterEach(() => fixtures.splice(0).forEach(f => f.cleanup()));

it("installs the three design checks into this run's own store and records the base before any session", async () => {
  const s = setupDesignGate(fixtures), calls: GateInput[] = [];
  const result = await runJarvis(s.task, {...s.options, designGate: baseGate(observation(".old"), "pass", calls), runLoop: async loop => {
    expect(Object.keys(loop.checks)).toEqual(expect.arrayContaining(SIX));
    const store = new ChecksStore(loop.projectDir);
    expect(store.verify(Ledger.open(loop.projectDir)).ok).toBe(true);
    // Absolute pins point into this run's store; nothing in it names the private evals repo.
    const evals = realpathSync(s.f.evalsRepo);
    expect(texts(store.checksDir).filter(text => text.includes(evals))).toEqual([]);
    expect(readFileSync(join(store.checksDir, "fixtures", "impeccable.json"), "utf8")).toContain(join(realpathSync(store.checksDir), "fixtures", "qa-toolchain", "manifest.json"));
    // The base was captured once, on the snapshot's base revision, before the loop's first session.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.check.verify).toContain(`'${calls[0]!.revision}'`);
    expect(readDesignBaseline(store.checksDir)).toMatchObject({baseRevision:calls[0]!.revision,axeVersion:"4.10.3"});
    return {status:"complete" as const,done:[],blocked:[]};
  }});
  expect(result.error).toBeUndefined();
  expect(calls[0]!.revision).toBe(result.baseRevision);
  expect(result.designBaseline).toBe("recorded");
  expect(JSON.parse(readFileSync(join(result.resultsDir, "summary.json"), "utf8")).designBaseline).toBe("recorded");
}, 60_000);

it("a failed base capture leaves no baseline, so verification stays strict, and the summary says so", async () => {
  const s = setupDesignGate(fixtures);
  const result = await runJarvis(s.task, {...s.options, designGate: baseGate(observation(".old"), "fail"), runLoop: async loop => {
    expect(existsSync(join(loop.projectDir, "checks", "expected", "axe-base.json"))).toBe(false);
    return {status:"complete" as const,done:[],blocked:[]};
  }});
  expect(result.designBaseline).toBe("failed");
}, 60_000);

it("runs every cheap refusal before the base revision is built, served and captured", async () => {
  const s = setupDesignGate(fixtures), calls: GateInput[] = [];
  // The installed gate loses its unit check after the preflight.
  const preflight = async () => {
    rmSync(join(s.gateDir, "unit.check.json"));
    writeFileSync(join(s.gateDir, "other.check.json"), JSON.stringify({name:"other",cases:[{id:"u",command:"true"}],verify:"true",timeoutMs:1}));
    return {ok:true};
  };
  await expect(runJarvis(s.task, {...s.options, preflight, designGate: baseGate(observation(".old"), "pass", calls)})).rejects.toThrow(/no "unit" check/);
  expect(calls).toHaveLength(0); expect(s.runLoop).not.toHaveBeenCalled();
}, 60_000);
