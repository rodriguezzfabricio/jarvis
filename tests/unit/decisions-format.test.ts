import { describe, expect, it } from "vitest";
import {
  addDecision, parseRegister, queryDecisions, serializeRegister, supersedeDecision,
  type DecisionInput,
} from "../../packages/cli/src/decisions/format.ts";

const input: DecisionInput = {
  date: "2026-10-24", decision: "Initial outreach only; no follow-ups", madeBy: "fabricio",
  source: "docs/intake.md#answer-1", class: "Taste", reversibility: "moderate",
  why: "Avoid repeated contact", alternatives: ["Allow one follow-up"], dependsOn: ["outreach workflow"],
};

const header = "| ID | Date | Decision | Made by | Status | Source | Class | Reversibility | Why | Alternatives | Depends on | Supersedes |";
const separator = `| ${Array.from({ length: 12 }, () => "---").join(" | ")} |`;
const row = '| D1 | 2026-10-24 | Initial outreach only; no follow-ups | fabricio | active | docs/intake.md#answer-1 | Taste | moderate | Avoid repeated contact | ["Allow one follow-up"] | ["outreach workflow"] | - |';
const fixture = `# Decisions\n\n${header}\n${separator}\n${row}\n`;

function fresh() { return parseRegister(serializeRegister(addDecision(parseRegister(""), input))); }

describe("decision register format (decisions 11, 40, 48)", () => {
  it("reads every required field and preserves a Markdown register byte for byte", () => {
    const doc = parseRegister(fixture);
    expect(doc.entries).toEqual([{ id: 1, ...input, status: { kind: "active" }, supersedes: null }]);
    expect(serializeRegister(doc)).toBe(fixture);
  });

  it.each(["", "\n", fixture.replaceAll("\n", "\r\n"), fixture.trimEnd(), fixture + "\n\n"])(
    "preserves blank lines, line endings and missing final newlines: %j", (text) => {
      expect(serializeRegister(parseRegister(text))).toBe(text);
    },
  );

  it("round-trips delimiters, backslashes, Unicode and multiline values without extra physical lines", () => {
    const choice = { ...input, decision: "a | b\\c\nline 2\r✓", why: "literal \\n and |", alternatives: ["x|y", "a\\b\nc"] };
    const doc = addDecision(parseRegister(""), choice);
    const text = serializeRegister(doc);
    expect(text.split("\n")).toHaveLength(6);
    expect(parseRegister(text).entries[0]).toEqual(doc.entries[0]);
  });

  it("preserves whitespace at the edges of newly serialized field values", () => {
    const choice = { ...input, decision: "\u00a0choice\u2003", why: "\twhy\n", source: "docs/answer.md" };
    const doc = addDecision(parseRegister(""), choice);
    expect(parseRegister(serializeRegister(doc)).entries[0]).toEqual(doc.entries[0]);
  });

  it.each([
    ["missing cell", row.replace(" | moderate", "")],
    ["unknown maker", row.replace("fabricio", "someone")],
    ["unknown class", row.replace("Taste", "Other")],
    ["unknown reversibility", row.replace("moderate", "maybe")],
    ["invalid date", row.replace("2026-10-24", "2026-02-30")],
    ["empty source", row.replace("docs/intake.md#answer-1", "")],
    ["bad alternatives", row.replace('["Allow one follow-up"]', "[]oops")],
    ["bad dependencies", row.replace('["outreach workflow"]', '[1]')],
    ["unknown status", row.replace("active", "deleted")],
    ["zero ID", row.replace("D1", "D0")],
    ["unknown escape", row.replace("Avoid repeated contact", "bad\\q")],
    ["broken supersession", row.replace("active", 'superseded-by D2 on 2026-10-24: "new policy"')],
  ])("rejects %s with its physical line number", (_name, broken) => {
    expect(() => parseRegister(fixture.replace(row, broken))).toThrow(/line 5:/i);
  });

  it("rejects duplicate IDs, arbitrary text, and a missing header separator", () => {
    expect(() => parseRegister(fixture + row + "\n")).toThrow(/line 6:.*duplicate/i);
    expect(() => parseRegister(fixture + "not a decision\n")).toThrow(/line 6:/i);
    expect(() => parseRegister(fixture.replace(separator, "wrong"))).toThrow(/line 4:/i);
  });

  it("adds to an empty titled register even when the heading contains a pipe", () => {
    const doc = addDecision(parseRegister("# Choices | project\n"), input);
    expect(parseRegister(serializeRegister(doc)).entries[0]?.decision).toBe(input.decision);
  });

  it("records table presence separately from pipes in headings", () => {
    expect(parseRegister("").hasTable).toBe(false);
    expect(parseRegister("# Choices | project\n").hasTable).toBe(false);
    expect(parseRegister(fixture).hasTable).toBe(true);
    expect(parseRegister(fixture.replace(row + "\n", "")).hasTable).toBe(true);
  });

  it("reports malformed headers once, with the correct physical line number", () => {
    let message = "";
    try { parseRegister(fixture.replace("| Date |", "| Wrong |")); }
    catch (error) { message = (error as Error).message; }
    expect(message).toMatch(/^Decision register line 3: unexpected table header$/);
  });

  it("reports serialization history errors without inventing a source line", () => {
    const doc = fresh();
    doc.entries[0]!.supersedes = 99;
    expect(() => serializeRegister(doc)).toThrow(/supersedes/);
    expect(() => serializeRegister(doc)).not.toThrow(/line 1:/);
  });

  it("rejects a one-way superseded-by link on its actual source line", () => {
    const doc = supersedeDecision(fresh(), 1, { ...input, date: "2026-10-25" }, "2026-10-25", "Changed");
    const raw = serializeRegister(doc).replace(/\| D1 \|\n$/, "| - |\n");
    expect(() => parseRegister(raw)).toThrow(/line 5:.*superseded-by/);
  });

  it("rejects a supersession dated before the old decision, even with matching target dates", () => {
    const doc = supersedeDecision(fresh(), 1, { ...input, date: "2026-10-25" }, "2026-10-25", "Changed");
    const raw = serializeRegister(doc).replaceAll("2026-10-25", "2026-10-23");
    expect(() => parseRegister(raw)).toThrow(/line 5:.*date/);
  });

  it("searches numeric keywords when no such ID exists, while existing IDs take priority", () => {
    const doc = addDecision(fresh(), { ...input, decision: "Retain 30 days; 1 month" });
    expect(queryDecisions(doc, "30").map((e) => e.id)).toEqual([2]);
    expect(queryDecisions(doc, "1").map((e) => e.id)).toEqual([1]);
    expect(queryDecisions(doc, "D30")).toEqual([]);
  });

  it("allocates the maximum ID plus one, including superseded IDs, without mutating the input", () => {
    const original = parseRegister(fixture.replace("D1", "D7"));
    const next = addDecision(original, { ...input, decision: "Use a queue" });
    expect(next.entries.map((e) => e.id)).toEqual([7, 8]);
    expect(original.entries).toHaveLength(1);
    expect(serializeRegister(next)).toContain(row.replace("D1", "D7"));
  });

  it("supersedes with a dated reason, reciprocal links, and all prior fields intact", () => {
    const original = fresh();
    const reason = "Fabricio requested it | now\nmore\u2028context\u2029end";
    const changed = supersedeDecision(original, 1, { ...input, date: "2026-10-25", decision: "Allow one follow-up" }, "2026-10-25", reason);
    expect(original.entries[0]?.status).toEqual({ kind: "active" });
    expect(changed.entries[0]).toEqual({ ...original.entries[0], status: { kind: "superseded", by: 2, date: "2026-10-25", reason } });
    expect(changed.entries[1]).toMatchObject({ id: 2, supersedes: 1, status: { kind: "active" } });
    expect(parseRegister(serializeRegister(changed)).entries).toEqual(changed.entries);
  });

  it("refuses deleting entries, superseding twice, nonexistent IDs, empty reasons, and backdated changes", () => {
    const doc = fresh();
    expect(() => serializeRegister({ ...doc, entries: [] })).toThrow(/drop/i);
    expect(() => supersedeDecision(doc, 9, input, input.date, "reason")).toThrow(/not found/i);
    expect(() => supersedeDecision(doc, 1, input, input.date, " ")).toThrow(/reason/i);
    expect(() => supersedeDecision(doc, 1, input, "2026-10-23", "reason")).toThrow(/date/i);
    const changed = supersedeDecision(doc, 1, input, input.date, "reason");
    expect(() => supersedeDecision(changed, 1, input, input.date, "again")).toThrow(/superseded/i);
  });

  it("validates additions and reciprocal history rather than emitting malformed rows", () => {
    expect(() => addDecision(fresh(), { ...input, class: "unknown" } as never)).toThrow(/class/i);
    const doc = fresh();
    expect(() => serializeRegister({ ...doc, entries: [{ ...doc.entries[0]!, supersedes: 99 }] })).toThrow(/supersedes/i);
  });

  it("queries case-insensitive literal keywords and exact IDs, with connected history only when requested", () => {
    let doc = supersedeDecision(fresh(), 1, { ...input, decision: "Permit a reminder" }, input.date, "New request");
    doc = addDecision(doc, { ...input, decision: "Use SQLite", source: "docs/storage.md" });
    expect(queryDecisions(doc, "REMINDER").map((e) => e.id)).toEqual([2]);
    expect(queryDecisions(doc, "D1")).toEqual([]);
    expect(queryDecisions(doc, "2").map((e) => e.id)).toEqual([2]);
    expect(queryDecisions(doc, "D1", { history: true }).map((e) => e.id)).toEqual([1, 2]);
    expect(queryDecisions(doc, "follow-ups", { history: true }).map((e) => e.id)).toEqual([1, 2]);
    expect(queryDecisions(doc, "New request", { history: true }).map((e) => e.id)).toEqual([1, 2]);
    expect(queryDecisions(doc, "storage").map((e) => e.id)).toEqual([3]);
    expect(queryDecisions(doc, "[.*")).toEqual([]);
    expect(() => queryDecisions(doc, " ")).toThrow(/query/i);
  });
});
