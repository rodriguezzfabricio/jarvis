import { fstatSync, fsyncSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { shortTmp } from "../helpers.ts";
import { addDecision, parseRegister, serializeRegister, supersedeDecision, type DecisionInput } from "../../packages/cli/src/decisions/format.ts";
import { firmness } from "../../packages/cli/src/decisions/conflicts.ts";
import { DecisionRegister } from "../../packages/cli/src/decisions/store.ts";

const root = shortTmp("jds-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const input: DecisionInput = { date: "2026-10-24", decision: "Keep the old rule", madeBy: "fabricio", source: "evidence.md#one", class: "Taste", reversibility: "easy", why: "A deliberate choice", alternatives: [], dependsOn: [] };
function repo() { const dir = join(root, String(++n)); mkdirSync(dir); writeFileSync(join(dir, "evidence.md"), "# Evidence\n"); return dir; }
const protectedEntries = [
  { madeBy: "fabricio", class: "Mechanical" }, { madeBy: "accepted-default", class: "Taste" },
  { madeBy: "inferred", class: "Mechanical" }, { madeBy: "unconfirmed-default", class: "Taste" },
  { madeBy: "jarvis", class: "Challenge" },
] as const;

describe("decision 85 write boundaries", () => {
  it.each(protectedEntries)("only Fabricio can supersede $madeBy/$class", (old) => {
    const register = DecisionRegister.open(repo());
    register.add({ ...input, ...old });
    const before = readFileSync(register.path, "utf8");
    for (const madeBy of ["jarvis", "accepted-default", "unconfirmed-default", "inferred"] as const) {
      expect(() => register.supersede(1, { ...input, madeBy }, input.date, "Change it")).toThrow(/user|fabricio/i);
      expect(readFileSync(register.path, "utf8")).toBe(before);
    }
    expect(register.supersede(1, { ...input, madeBy: "fabricio" }, input.date, "My choice").id).toBe(2);
  });

  it("enforces firmness in pure supersession and generic writes too", () => {
    const register = DecisionRegister.open(repo());
    register.add(input);
    const doc = register.read();
    expect(() => supersedeDecision(doc, 1, { ...input, madeBy: "jarvis" }, input.date, "Idea")).toThrow(/user|fabricio/i);
    const forged = supersedeDecision(doc, 1, input, input.date, "My choice");
    expect(forged.entries.map((entry) => entry.id)).toEqual([1, 2]);
    forged.entries[1]!.madeBy = "jarvis";
    expect(() => register.write(forged)).toThrow(/user|fabricio/i);
  });

  it.each(["Mechanical", "Taste"] as const)("Jarvis revisits its own %s only with a reason", (kind) => {
    const register = DecisionRegister.open(repo());
    register.add({ ...input, madeBy: "jarvis", class: kind });
    expect(() => register.supersede(1, { ...input, madeBy: "jarvis" }, input.date, " ")).toThrow(/reason/i);
    expect(register.supersede(1, { ...input, madeBy: "jarvis" }, input.date, "Measured new evidence").id).toBe(2);
  });

  it("treats timeout defaults as confirm-once, and supports the settled reversible default", () => {
    const doc = addDecision(parseRegister(""), { ...input, madeBy: "unconfirmed-default", reversibility: "reversible" });
    expect(firmness(doc.entries[0]!)).toEqual({ level: "confirm-once", jarvisMayRevisit: false, confirmationRequired: true });
    expect(parseRegister(serializeRegister(doc)).entries).toEqual(doc.entries);
  });

  it.each(["/etc/passwd", "../outside.md", "a/../evidence.md", "./evidence.md", "a//b", "a/./b", "a\\b", "C:/outside.md", "evidence.md\n", "evidence.md#bad\u0000", "evidence.md#", "evidence.md#one#two"])("rejects unsafe source syntax in the input schema: %j", (source) => {
    expect(() => addDecision(parseRegister(""), { ...input, source })).toThrow(/source/i);
  });

  it("refuses missing sources and source symlinks escaping the repo, while allowing contained links and anchors", () => {
    const dir = repo();
    const outside = join(root, "outside.md");
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(dir, "escape.md"));
    symlinkSync(join(dir, "evidence.md"), join(dir, "inside.md"));
    const register = DecisionRegister.open(dir);
    expect(() => register.add({ ...input, source: "missing.md" })).toThrow(/source.*exist/i);
    expect(() => register.add({ ...input, source: "escape.md" })).toThrow(/source.*repo/i);
    expect(register.add({ ...input, source: "inside.md#anchor" }).id).toBe(1);
  });

  it("generic writes also validate the source's real path", () => {
    const register = DecisionRegister.open(repo());
    register.add(input);
    const doc = addDecision(register.read(), { ...input, source: "missing.md" });
    expect(() => register.write(doc)).toThrow(/source.*exist/i);
    expect(register.read().entries).toHaveLength(1);
  });

  it.each(["docs", "decisions.md"] as const)("refuses symlinked %s on reads and writes", (kind) => {
    const dir = repo();
    const other = repo();
    mkdirSync(join(other, "docs"));
    const target = join(other, "docs/decisions.md");
    writeFileSync(target, "");
    if (kind === "docs") symlinkSync(join(other, "docs"), join(dir, "docs"));
    else { mkdirSync(join(dir, "docs")); symlinkSync(target, join(dir, "docs/decisions.md")); }
    const register = DecisionRegister.open(dir);
    expect(() => register.read()).toThrow(/symlink|real path/i);
    expect(() => register.add(input)).toThrow(/symlink|real path/i);
    expect(readFileSync(target, "utf8")).toBe("");
  });

  it("stores and prints the lock owner's pid, host and ISO time without stealing it", () => {
    const dir = repo();
    let seen = false;
    const register = DecisionRegister.open(dir, { rename: (from, to) => {
      const lock = readFileSync(join(dir, "docs/.decisions.lock"), "utf8");
      const owner = JSON.parse(lock) as { pid: number; host: string; time: string };
      expect(owner.pid).toBe(process.pid);
      expect(owner.host).toBe(hostname());
      expect(new Date(owner.time).toISOString()).toBe(owner.time);
      let message = "";
      try { DecisionRegister.open(dir).add(input); } catch (error) { message = (error as Error).message; }
      expect(message).toMatch(/busy/i);
      expect(message).toContain(String(owner.pid));
      expect(message).toContain(owner.host);
      expect(message).toContain(owner.time);
      expect(readFileSync(join(dir, "docs/.decisions.lock"), "utf8")).toBe(lock);
      seen = true;
      renameSync(from, to);
    } });
    register.add(input);
    expect(seen).toBe(true);
  });

  it("does not follow a lock symlink when reporting its owner", () => {
    const dir = repo();
    mkdirSync(join(dir, "docs"));
    const outside = join(root, "private-owner.txt");
    const marker = "PRIVATE_FIXTURE_MUST_NOT_APPEAR";
    const content = JSON.stringify({ pid: 999, host: marker, time: "2026-10-24T00:00:00.000Z" });
    writeFileSync(outside, content);
    symlinkSync(outside, join(dir, "docs/.decisions.lock"));
    let message = "";
    try { DecisionRegister.open(dir).add(input); } catch (error) { message = (error as Error).message; }
    expect(message).toMatch(/busy/i);
    expect(message).not.toContain(marker);
    expect(readFileSync(outside, "utf8")).toBe(content);
  });

  it("syncs the completed file before rename and the directory after rename", () => {
    const dir = repo();
    const steps: string[] = [];
    const register = DecisionRegister.open(dir, {
      sync: (fd) => { steps.push(fstatSync(fd).isDirectory() ? "directory sync" : "file sync"); fsyncSync(fd); },
      rename: (from, to) => { steps.push("rename"); renameSync(from, to); },
    });
    register.add(input);
    expect(steps).toEqual(["file sync", "rename", "directory sync"]);
  });
});
