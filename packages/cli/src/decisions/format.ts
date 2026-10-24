import { z } from "zod";
import { assertMaySupersede } from "./conflicts.ts";
import { isRepoRelativeSource } from "./source.ts";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "invalid calendar date");
const text = z.string().refine((value) => value.trim().length > 0, "must not be blank");
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const inputSchema = z.object({
  date, decision: text, madeBy: z.enum(["fabricio", "accepted-default", "jarvis", "inferred", "unconfirmed-default"]),
  source: z.string().refine(isRepoRelativeSource, "source must be a normalized repo-relative path with an optional anchor"), class: z.enum(["Mechanical", "Taste", "Challenge"]),
  reversibility: z.enum(["easy", "moderate", "hard", "irreversible", "reversible"]),
  why: text, alternatives: z.array(text), dependsOn: z.array(text),
}).strict();
const statusSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("active") }).strict(),
  z.object({ kind: z.literal("superseded"), by: id, date, reason: text }).strict(),
]);
const decisionSchema = inputSchema.extend({ id, status: statusSchema, supersedes: id.nullable() });
export type DecisionInput = z.infer<typeof inputSchema>;
export type Decision = z.infer<typeof decisionSchema>;
export interface RegisterDocument { entries: Decision[]; source: string; hasTable: boolean }

const columns = ["ID", "Date", "Decision", "Made by", "Status", "Source", "Class", "Reversibility", "Why", "Alternatives", "Depends on", "Supersedes"];
const header = `| ${columns.join(" | ")} |`;
const separator = `| ${columns.map(() => "---").join(" | ")} |`;

function fail(line: number | undefined, message: string): never {
  throw new Error(line === undefined ? `Decision register: ${message}` : `Decision register line ${line}: ${message}`);
}
function encode(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll("\n", "\\n").replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t").replace(/^ +| +$/g, (spaces) => "\\s".repeat(spaces.length));
}
function cells(line: string): string[] {
  if (!line.startsWith("|") || !line.endsWith("|")) throw new Error("expected a table row");
  const result: string[] = [];
  let cell = "";
  const content = line.slice(1, -1);
  const finish = () => {
    // Trim the table's padding before decoding escaped field whitespace.
    result.push(cell.replace(/^[ \t]+|[ \t]+$/g, "").replace(/\\([\s\S])/g, (_match, escaped: string) => {
      if (escaped === "\\" || escaped === "|") return escaped;
      if (escaped === "n") return "\n";
      if (escaped === "r") return "\r";
      if (escaped === "t") return "\t";
      if (escaped === "s") return " ";
      throw new Error("unknown cell escape");
    }));
    cell = "";
  };
  for (let i = 0; i < content.length; i++) {
    const c = content[i]!;
    if (c === "\\") {
      if (content[i + 1] === undefined) throw new Error("unfinished cell escape");
      cell += c + content[++i];
    } else if (c === "|") finish();
    else cell += c;
  }
  finish();
  if (result.length !== columns.length) throw new Error(`expected ${columns.length} cells`);
  return result;
}
function parseId(value: string): number {
  if (!/^D[1-9]\d*$/.test(value)) throw new Error("invalid decision ID");
  return id.parse(Number(value.slice(1)));
}
function parseRow(line: string): Decision {
  const c = cells(line);
  let status: Decision["status"] = { kind: "active" };
  if (c[4] !== "active") {
    const match = /^superseded-by (D[1-9]\d*) on (\d{4}-\d{2}-\d{2}): ([\s\S]+)$/.exec(c[4]!);
    if (!match) throw new Error("invalid status");
    status = { kind: "superseded", by: parseId(match[1]!), date: match[2]!, reason: JSON.parse(match[3]!) as string };
  }
  return decisionSchema.parse({
    id: parseId(c[0]!), date: c[1], decision: c[2], madeBy: c[3], status,
    source: c[5], class: c[6], reversibility: c[7], why: c[8],
    alternatives: JSON.parse(c[9]!), dependsOn: JSON.parse(c[10]!),
    supersedes: c[11] === "-" ? null : parseId(c[11]!),
  });
}
function row(entry: Decision): string {
  const s = entry.status;
  const status = s.kind === "active" ? "active" : `superseded-by D${s.by} on ${s.date}: ${JSON.stringify(s.reason)}`;
  return `| ${[
    `D${entry.id}`, entry.date, entry.decision, entry.madeBy, status, entry.source,
    entry.class, entry.reversibility, entry.why, JSON.stringify(entry.alternatives), JSON.stringify(entry.dependsOn),
    entry.supersedes === null ? "-" : `D${entry.supersedes}`,
  ].map(encode).join(" | ")} |`;
}

function validateHistory(entries: Decision[], lineOf: (entry: Decision) => number | undefined): void {
  const byId = new Map<number, Decision>();
  for (const entry of entries) {
    if (byId.has(entry.id)) fail(lineOf(entry), `duplicate ID D${entry.id}`);
    byId.set(entry.id, entry);
  }
  for (const entry of entries) {
    if (entry.status.kind === "superseded") {
      const next = byId.get(entry.status.by);
      if (!next || next.id <= entry.id || next.supersedes !== entry.id || next.date !== entry.status.date || entry.status.date < entry.date) {
        fail(lineOf(entry), "invalid superseded-by link or date");
      }
    }
    if (entry.supersedes !== null) {
      const old = byId.get(entry.supersedes);
      if (!old || old.status.kind !== "superseded" || old.status.by !== entry.id) fail(lineOf(entry), "invalid supersedes link");
    }
  }
}

/** One physical Markdown row per decision; escapes keep pipes and newlines inside cells. */
export function parseRegister(source: string): RegisterDocument {
  const entries: Decision[] = [];
  const lineNumbers = new Map<Decision, number>();
  let state: "header" | "separator" | "rows" = "header";
  const lines = source.split(/\r\n|\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const number = index + 1;
    try {
      if (state === "separator") {
        if (!cells(line).every((cell) => /^:?-{3,}:?$/.test(cell))) throw new Error("expected header separator");
        state = "rows";
      } else if (line.trim() === "" || (state === "header" && /^# .+/.test(line))) continue;
      else if (state === "header") {
        if (JSON.stringify(cells(line)) !== JSON.stringify(columns)) throw new Error("unexpected table header");
        state = "separator";
      } else {
        const entry = parseRow(line);
        entries.push(entry);
        lineNumbers.set(entry, number);
      }
    } catch (error) {
      fail(number, error instanceof Error ? error.message : String(error));
    }
  }
  if (state === "separator") fail(lines.length, "missing header separator");
  validateHistory(entries, (entry) => lineNumbers.get(entry)!);
  return { entries, source, hasTable: state === "rows" };
}

export function serializeRegister(document: RegisterDocument): string {
  const original = parseRegister(document.source);
  const entries = document.entries.map((entry) => decisionSchema.parse(entry));
  validateHistory(entries, () => undefined);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  for (const entry of original.entries) {
    if (!byId.has(entry.id)) throw new Error(`Refusing to drop decision D${entry.id}`);
  }
  if (JSON.stringify(entries) === JSON.stringify(original.entries)) return document.source;
  const newline = document.source.includes("\r\n") ? "\r\n" : "\n";
  let output = document.source;
  if (!original.hasTable) {
    output += `${output && !output.endsWith("\n") ? newline : ""}${output ? "" : `# Decisions${newline}${newline}`}${header}${newline}${separator}${newline}`;
  }
  const oldIds = new Set(original.entries.map((entry) => entry.id));
  const oldById = new Map(original.entries.map((entry) => [entry.id, entry]));
  output = output.split(/\r\n|\n/).map((line) => {
    if (!/^\|\s*D[1-9]\d*\s*\|/.test(line)) return line;
    const old = parseRow(line);
    const next = byId.get(old.id)!;
    return JSON.stringify(oldById.get(old.id)) === JSON.stringify(next) ? line : row(next);
  }).join(newline);
  const added = entries.filter((entry) => !oldIds.has(entry.id));
  if (added.length) output += `${output.endsWith("\n") ? "" : newline}${added.map(row).join(newline)}${newline}`;
  // Reparse: a serializer must never acknowledge a document it cannot read back.
  parseRegister(output);
  return output;
}

export function addDecision(document: RegisterDocument, input: DecisionInput): RegisterDocument {
  const value = inputSchema.parse(input);
  const nextId = Math.max(0, ...document.entries.map((entry) => entry.id)) + 1;
  const entry = decisionSchema.parse({ ...value, id: nextId, status: { kind: "active" }, supersedes: null });
  return { ...document, entries: [...document.entries, entry] };
}

export function supersedeDecision(document: RegisterDocument, oldId: number, input: DecisionInput, on: string, reason: string): RegisterDocument {
  const old = document.entries.find((entry) => entry.id === oldId);
  if (!old) throw new Error(`Decision D${oldId} not found`);
  if (old.status.kind !== "active") throw new Error(`Decision D${oldId} is already superseded`);
  date.parse(on);
  if (on < old.date || input.date !== on) throw new Error("Supersession date must match the new decision and not predate the old one");
  assertMaySupersede(old, input.madeBy, reason);
  const next = addDecision(document, input);
  const newId = next.entries.at(-1)!.id;
  return { ...next, entries: next.entries.map((entry) => entry.id === oldId
    ? { ...entry, status: { kind: "superseded", by: newId, date: on, reason } }
    : entry.id === newId ? { ...entry, supersedes: oldId } : entry) };
}

export function queryDecisions(document: RegisterDocument, query: string, options: { history?: boolean } = {}): Decision[] {
  const keyword = query.trim().toLowerCase();
  if (!keyword) throw new Error("Decision query must not be blank");
  const candidateId = /^d?[1-9]\d*$/.test(keyword) ? Number(keyword.replace(/^d/, "")) : null;
  const exactId = candidateId !== null && (keyword.startsWith("d") || document.entries.some((entry) => entry.id === candidateId)) ? candidateId : null;
  const matches = document.entries.filter((entry) => (options.history || entry.status.kind === "active") && (exactId !== null
    ? entry.id === exactId
    : [entry.decision, entry.why, entry.source, entry.status.kind === "superseded" ? entry.status.reason : "", ...entry.alternatives, ...entry.dependsOn].join("\n").toLowerCase().includes(keyword)));
  const ids = new Set(matches.map((entry) => entry.id));
  if (options.history) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const entry of document.entries) {
        if (ids.has(entry.id)) {
          for (const link of [entry.supersedes, entry.status.kind === "superseded" ? entry.status.by : null]) {
            if (link !== null && !ids.has(link)) { ids.add(link); changed = true; }
          }
        }
      }
    }
  }
  return document.entries.filter((entry) => ids.has(entry.id));
}
