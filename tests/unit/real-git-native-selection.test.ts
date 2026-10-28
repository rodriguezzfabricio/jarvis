import { rmSync } from "node:fs";
import { afterAll, expect, it } from "vitest";
import { shortTmp } from "../helpers.ts";
import * as probePlan from "./helpers/native-git-test.ts";
import { runNativeGitProbe } from "./helpers/native-git-test.ts";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
function root() { const dir = shortTmp("jgs-"); roots.push(dir); return dir; }

it("runs only the selected comparison and records both actual observations", () => {
  const result = runNativeGitProbe("spawn", root(), "comparisons", ["absolute"]);
  expect(Object.keys(result.cases)).toEqual(["absolute"]);
  expect(Object.keys(result.controls)).toEqual([]);
  expect(result.executions).toEqual([{ name: "absolute", native: true }, { name: "absolute", native: false }]);
});
it("runs only the selected fault control and records both actual observations", () => {
  const result = runNativeGitProbe("spawn", root(), "faults", ["unchanged"]);
  expect(Object.keys(result.controls)).toEqual(["unchanged"]);
  expect(Object.keys(result.cases)).toEqual([]);
  expect(result.executions).toEqual([{ name: "unchanged", native: true }, { name: "unchanged", native: false }]);
});

it("partitions every API, comparison and fault exactly once into bounded batches", () => {
  expect(probePlan.nativeGitApis).toEqual(["execFileSync", "spawnSync", "spawn", "execFile", "promisified"]);
  expect(probePlan.comparisonBatches).toEqual([
    ["absolute", "first PATH executable", "relative PATH"],
    ["empty PATH entry", "before earlier executable", "new earlier executable"],
    ["missing PATH", "no options", "shell"],
    ["absolute system git", "CPATH", "LIBRARY_PATH"],
    ["MANPATH", "SDKROOT", "failed git"],
  ]);
  expect(probePlan.faultBatches).toEqual([
    ["unchanged", "redirect", "argv"],
    ["cwd", "CPATH", "LIBRARY_PATH"],
    ["MANPATH", "SDKROOT", "relative PATH"],
    ["cached PATH", "failed git"],
  ]);
});
