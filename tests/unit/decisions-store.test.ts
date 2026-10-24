import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { shortTmp } from "../helpers.ts";
import { addDecision, parseRegister, serializeRegister, type DecisionInput } from "../../packages/cli/src/decisions/format.ts";
import { DecisionRegister } from "../../packages/cli/src/decisions/store.ts";

const root = shortTmp("jtd-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
function repo() { const dir = join(root, String(++n)); mkdirSync(dir); writeFileSync(join(dir, "intake.md"), "# Intake\n"); return dir; }
const input: DecisionInput = {
  date: "2026-10-24", decision: "No follow-ups", madeBy: "fabricio", source: "intake.md",
  class: "Mechanical", reversibility: "easy", why: "Avoid spam", alternatives: ["One reminder"], dependsOn: [],
};
function seeded() {
  const dir = repo();
  const register = DecisionRegister.open(dir);
  register.add(input);
  return { dir, register, path: join(dir, "docs/decisions.md") };
}

describe("atomic decision storage", () => {
  it("initializes a missing register and preserves history across add and supersede", () => {
    const dir = repo();
    const register = DecisionRegister.open(dir);
    expect(register.read().entries).toEqual([]);
    expect(existsSync(join(dir, "docs"))).toBe(false);
    expect(register.add(input).id).toBe(1);
    expect(register.supersede(1, { ...input, decision: "One reminder" }, input.date, "Fabricio changed direction").id).toBe(2);
    expect(register.add({ ...input, decision: "Use SQLite" }).id).toBe(3);
    const entries = DecisionRegister.open(dir).read().entries;
    expect(entries.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(entries[0]?.status).toMatchObject({ kind: "superseded", by: 2, reason: "Fabricio changed direction" });
    expect(entries[1]?.supersedes).toBe(1);
    expect(readdirSync(join(dir, "docs"))).toEqual(["decisions.md"]);
  });

  it("keeps accepting writes after an earlier decision's source file is deleted", () => {
    const { dir, register } = seeded();
    writeFileSync(join(dir, "spec.md"), "# Spec\n");
    rmSync(join(dir, "intake.md"));
    expect(register.add({ ...input, decision: "Use SQLite", source: "spec.md" }).id).toBe(2);
    expect(() => register.add({ ...input, decision: "Use Postgres", source: "intake.md" })).toThrow(/Source must exist/);
  });

  it("writes to a sibling temporary file and renames only the complete valid contents", () => {
    const { dir, path } = seeded();
    const old = readFileSync(path, "utf8");
    let called = false;
    const register = DecisionRegister.open(dir, { rename: (from, to) => {
      called = true;
      expect(to).toBe(path);
      expect(from).not.toBe(to);
      expect(from.startsWith(join(dir, "docs/"))).toBe(true);
      expect(readFileSync(path, "utf8")).toBe(old);
      expect(parseRegister(readFileSync(from, "utf8")).entries).toHaveLength(2);
      renameSync(from, to);
    } });
    register.add(input);
    expect(called).toBe(true);
    expect(parseRegister(readFileSync(path, "utf8")).entries).toHaveLength(2);
  });

  it.each(["write", "rename"] as const)("leaves the old register intact after a %s failure and cleans temporary files", (step) => {
    const { dir, path } = seeded();
    const old = readFileSync(path, "utf8");
    const register = DecisionRegister.open(dir, step === "write" ? { write: (fd, value) => {
      writeFileSync(fd, value.slice(0, 30));
      throw new Error("injected partial write");
    } } : { rename: () => { throw new Error("injected rename failure"); } });
    expect(() => register.add(input)).toThrow(/injected/);
    expect(readFileSync(path, "utf8")).toBe(old);
    expect(readdirSync(join(dir, "docs"))).toEqual(["decisions.md"]);
    expect(DecisionRegister.open(dir).add(input).id).toBe(2);
  });

  it("refuses dropping an existing entry even if the caller forges an empty baseline", () => {
    const { register, path } = seeded();
    const old = readFileSync(path, "utf8");
    expect(() => register.write(parseRegister(""))).toThrow(/drop/i);
    expect(readFileSync(path, "utf8")).toBe(old);
  });

  it("refuses rewriting a decision or erasing supersession history while retaining its ID", () => {
    const { register, path } = seeded();
    const doc = register.read();
    expect(() => register.write({ ...doc, entries: [{ ...doc.entries[0]!, decision: "silently changed" }] })).toThrow(/rewrite/i);
    register.supersede(1, input, input.date, "New direction");
    const changed = register.read();
    expect(() => register.write({ ...changed, entries: changed.entries.map((e) => ({ ...e, status: { kind: "active" }, supersedes: null })) })).toThrow(/history|rewrite/i);
    expect(parseRegister(readFileSync(path, "utf8")).entries[0]?.status.kind).toBe("superseded");
  });

  it("refuses rewriting the reason on a completed supersession", () => {
    const { register, path } = seeded();
    register.supersede(1, input, input.date, "Fabricio's original reason");
    const doc = register.read();
    const old = doc.entries[0]!;
    if (old.status.kind !== "superseded") throw new Error("expected superseded fixture");
    old.status.reason = "A different rationale";
    const before = readFileSync(path, "utf8");
    expect(() => register.write(doc)).toThrow(/rewrite history/i);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("refuses stale snapshots rather than overwriting an intervening writer", () => {
    const { register, path } = seeded();
    const snapshot = register.read();
    register.add(input);
    const old = readFileSync(path, "utf8");
    expect(() => register.write(addDecision(snapshot, { ...input, decision: "Different choice" }))).toThrow(/stale/i);
    expect(readFileSync(path, "utf8")).toBe(old);
  });

  it("refuses a stale snapshot even when only formatting changed on disk", () => {
    const { register, path } = seeded();
    const snapshot = register.read();
    const edited = readFileSync(path, "utf8") + "\n";
    writeFileSync(path, edited);
    expect(() => register.write(snapshot)).toThrow(/stale/i);
    expect(readFileSync(path, "utf8")).toBe(edited);
  });

  it("excludes a second writer across the entire read, ID allocation and rename", () => {
    const { dir } = seeded();
    let attempted = false;
    const register = DecisionRegister.open(dir, { rename: (from, to) => {
      attempted = true;
      expect(() => DecisionRegister.open(dir).add(input)).toThrow(/busy/i);
      renameSync(from, to);
    } });
    expect(register.add(input).id).toBe(2);
    expect(attempted).toBe(true);
    expect(DecisionRegister.open(dir).read().entries).toHaveLength(2);
  });

  it("fails closed on an existing lock and never removes another writer's lock", () => {
    const { dir, register } = seeded();
    const lock = join(dir, "docs/.decisions.lock");
    writeFileSync(lock, "other writer");
    expect(() => register.add(input)).toThrow(/busy/i);
    expect(readFileSync(lock, "utf8")).toBe("other writer");
  });

  it("refuses a malformed register and preserves its bytes", () => {
    const { register, path } = seeded();
    writeFileSync(path, "not a register\n");
    expect(() => register.add(input)).toThrow(/line 1:/i);
    expect(readFileSync(path, "utf8")).toBe("not a register\n");
  });

  it("refuses invented gaps in IDs and leaves the register unchanged", () => {
    const { register, path } = seeded();
    const doc = addDecision(register.read(), input);
    doc.entries[1]!.id = 7;
    const before = readFileSync(path, "utf8");
    expect(() => register.write(doc)).toThrow(/next ID/i);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("detects an external edit immediately before rename", () => {
    const { dir, path } = seeded();
    const before = readFileSync(path, "utf8");
    const edited = before + "\n";
    const register = DecisionRegister.open(dir, { write: (fd, value) => {
      writeFileSync(fd, value);
      writeFileSync(path, edited);
    } });
    expect(() => register.add(input)).toThrow(/stale/i);
    expect(readFileSync(path, "utf8")).toBe(edited);
    expect(readdirSync(join(dir, "docs"))).toEqual(["decisions.md"]);
  });

  it("reads and writes formatting unchanged when no decisions change", () => {
    const { register, path } = seeded();
    const raw = serializeRegister(register.read()).replaceAll("\n", "\r\n");
    writeFileSync(path, raw);
    register.write(register.read());
    expect(readFileSync(path, "utf8")).toBe(raw);
  });
});
