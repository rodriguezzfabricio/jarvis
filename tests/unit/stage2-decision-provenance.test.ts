import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { register } from "../../packages/cli/src/decisions/decide.ts";
import { DecisionRegister } from "../../packages/cli/src/decisions/store.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { projectId } from "../../packages/cli/src/config/project.ts";
import { answerRound, sendRound } from "../../packages/cli/src/intake/round.ts";
const { Command } = createRequire(new URL("../../packages/cli/package.json", import.meta.url))("commander") as { Command: new () => Parameters<typeof register>[0] };
const dirs: string[] = []; afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
async function setup(answer: unknown = { Q1: "Keep local history" }, question = "Keep history?") {
  const home = mkdtempSync(join(tmpdir(), "jarvis-answer-proof-")); dirs.push(home); const repo = join(home, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true }); mkdirSync(join(repo, ".jarvis/intake"), { recursive: true }); writeFileSync(join(repo, "evidence.md"), "Evidence");
  const ledger = Ledger.open(join(home, ".jarvis/projects", projectId(repo)));
  const round = join(repo, ".jarvis/intake/round-1.json");
  writeFileSync(round, JSON.stringify({ round: 1, spec: "docs/spec/v1.md", summary: "History", questions: [{ id: "Q1", topic: "scope", question, why: "Your data", default: { answer: "Keep local history", reason: "Safe" }, alternatives: ["Delete"] }], mockups: [] }));
  const deps = { repoDir: repo, ledger }; await sendRound(round, deps);
  const file = join(repo, "answers.json"); writeFileSync(file, JSON.stringify(answer)); answerRound(1, file, deps);
  const seq = (ledger.entries().find((e) => e.kind === "decision" && (e.data as { source?: string }).source === "intake")!.data as { answerSeq: number }).answerSeq;
  const command = new Command(); command.exitOverride(); command.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  register(command, { home });
  const run = (text: string, proof?: string, extra: string[] = []) => command.parseAsync(["decide", "--repo", repo, "--by", "user", "--class", "mechanical", "--source", "evidence.md", "--why", "Recorded answer", ...(proof ? ["--answer", proof] : []), ...extra, text], { from: "user" });
  return { home, repo, ledger, run, proof: `${seq}:Q1` };
}
it("refuses unproven user attribution without writing a register", async () => {
  const s = await setup(); await expect(s.run("Keep local history")).rejects.toThrow(/recorded.*answer|--answer/i);
  expect(DecisionRegister.open(s.repo).read().entries).toEqual([]);
});
it("accepts only the exact explicit answer backed by the verified project ledger", async () => {
  const s = await setup(); await s.run("Keep local history", s.proof);
  expect(DecisionRegister.open(s.repo).read().entries[0]).toMatchObject({ madeBy: "fabricio", decision: "Keep local history", why: expect.stringContaining(`Recorded user answer: ${s.proof}`) });
});
it.each(["defaults", {}])("never launders accepted defaults as user answers: %j", async (answer) => {
  const s = await setup(answer); await expect(s.run("Keep local history", s.proof)).rejects.toThrow(/explicit|user answer/i);
});
it("rejects different claims and fabricated or cross-project answer references", async () => {
  const s = await setup();
  for (const proof of [s.proof, "999:Q1", "1:UNKNOWN"]) await expect(s.run("Delete all history", proof)).rejects.toThrow();
  const other = await setup({ Q1: "Delete all history" });
  // Even a real sequence from another project cannot supply another project's answer.
  await expect(s.run("Delete all history", other.proof)).rejects.toThrow();
  expect(DecisionRegister.open(s.repo).read().entries).toEqual([]);
});
it("rejects a ledger tamper instead of trusting a manufactured answer", async () => {
  const s = await setup(); writeFileSync(join(s.ledger.dir, "head.hash"), "0".repeat(64));
  await expect(s.run("Keep local history", s.proof)).rejects.toThrow(/verif|tamper/i);
});

it("cannot reuse an unrelated answer to supersede a firm decision", async () => {
  const s = await setup();
  DecisionRegister.open(s.repo).add({ date: "2026-10-25", decision: "No production release", madeBy: "fabricio", source: "evidence.md", class: "Mechanical", reversibility: "easy", why: "User rule", alternatives: [], dependsOn: [] });
  await expect(s.run("Keep local history", s.proof, ["--supersedes", "D1", "--reason", "Reuse proof"])).rejects.toThrow(/supersed|D1/i);
  expect(DecisionRegister.open(s.repo).read().entries).toHaveLength(1);
});
it("allows a supersession that the recorded question explicitly identifies", async () => {
  const s = await setup({ Q1: "Keep local history" }, "Replace D1 with keeping local history?");
  DecisionRegister.open(s.repo).add({ date: "2026-10-25", decision: "Do not retain history", madeBy: "fabricio", source: "evidence.md", class: "Mechanical", reversibility: "easy", why: "Old rule", alternatives: [], dependsOn: [] });
  await s.run("Keep local history", s.proof, ["--supersedes", "D1", "--reason", "Keep local history"]);
  expect(DecisionRegister.open(s.repo).read().entries[1]).toMatchObject({ madeBy: "fabricio", supersedes: 1 });
});
it("still refuses a blank rationale when adding answer provenance", async () => {
  const s = await setup();
  await expect(s.run("Keep local history", s.proof, ["--why", " "])).rejects.toThrow(/why|blank/i);
  expect(DecisionRegister.open(s.repo).read().entries).toEqual([]);
});

// Decision 168: with --recorded-answer the entry states the decision, led by its question ID, while the
// CLI still verifies the user's exact words against the ledger and keeps them in Why.
it("stores a decision statement while verifying its separate exact answer", async () => {
  const s = await setup({ Q1: "yes" }, "Keep local history?");
  await s.run("Q1: Keep local history", s.proof, ["--recorded-answer", "yes"]);
  expect(DecisionRegister.open(s.repo).read().entries[0]).toMatchObject({
    madeBy: "fabricio", decision: "Q1: Keep local history",
    why: expect.stringContaining(`Recorded user answer: ${s.proof}\nExact answer: "yes"`),
  });
});
it("refuses a statement whose recorded answer is wrong, fabricated or a default", async () => {
  const s = await setup({ Q1: "yes" }, "Keep local history?");
  await expect(s.run("Q1: Keep local history", s.proof, ["--recorded-answer", "no"])).rejects.toThrow(/exact recorded answer/i);
  await expect(s.run("Q1: Keep local history", "999:Q1", ["--recorded-answer", "yes"])).rejects.toThrow();
  await expect(s.run("Q1: Keep local history", undefined, ["--recorded-answer", "yes"])).rejects.toThrow(/--answer/);
  const defaults = await setup("defaults");
  await expect(defaults.run("Q1: Keep local history", defaults.proof, ["--recorded-answer", "Keep local history"])).rejects.toThrow(/explicit|user answer/i);
  expect(DecisionRegister.open(s.repo).read().entries).toEqual([]);
});
it("requires the statement to start with the answered question's ID", async () => {
  const s = await setup({ Q1: "yes" }, "Keep local history?");
  for (const text of ["Keep local history", "Q2: Keep local history", "Q1:", "Q1:  ", "Q1 Keep local history"]) {
    await expect(s.run(text, s.proof, ["--recorded-answer", "yes"]), text).rejects.toThrow(/Q1: /);
  }
  expect(DecisionRegister.open(s.repo).read().entries).toEqual([]);
});
it("checks a supersession against the recorded question and answer, never the statement", async () => {
  const s = await setup({ Q1: "yes" }, "Keep local history?");
  DecisionRegister.open(s.repo).add({ date: "2026-10-25", decision: "Do not retain history", madeBy: "fabricio", source: "evidence.md", class: "Mechanical", reversibility: "easy", why: "Old rule", alternatives: [], dependsOn: [] });
  await expect(s.run("Q1: Replace D1 and keep local history", s.proof, ["--recorded-answer", "yes", "--supersedes", "D1", "--reason", "yes"])).rejects.toThrow(/D1/);
  expect(DecisionRegister.open(s.repo).read().entries).toHaveLength(1);
});
it("refuses --recorded-answer without --by user", async () => {
  const s = await setup({ Q1: "yes" });
  const command = new Command(); command.exitOverride(); command.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  register(command, { home: s.home });
  for (const by of ["default-accepted", "default-unconfirmed", "jarvis"]) {
    await expect(command.parseAsync(["decide", "--repo", s.repo, "--by", by, "--class", "mechanical", "--source", "evidence.md", "--why", "Default", "--recorded-answer", "yes", "Q1: Keep local history"], { from: "user" }), by).rejects.toThrow(/--by user/);
  }
  expect(DecisionRegister.open(s.repo).read().entries).toEqual([]);
});
