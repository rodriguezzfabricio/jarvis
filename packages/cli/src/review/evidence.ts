/**
 * What a reviewer is shown of the runner's gate evidence (decisions 49, 88, 111): the gate's verdict
 * (check, status, each case's exit) and a bounded excerpt of each evidence file, never whole logs. A
 * log's end is where its verdict is; for `go test -json` output the excerpt is a summary instead: the
 * counts, every failing test with the end of its output, and the final package lines. Every excerpt
 * says what was cut, and a hard total holds across all of a review's evidence files. The full files
 * stay runner-owned, hashed in the gate record; the service checks every byte of them before this runs.
 */

export const EVIDENCE_LIMITS = {
  /** A plain log: its last part, at most this many bytes (as JSON). */
  fileBytes: 16 * 1024,
  /** A `go test -json` summary, at most this many bytes (as JSON). */
  goSummaryBytes: 48 * 1024,
  /** The end of one failing test's output inside a go summary. */
  goTestOutputBytes: 4 * 1024,
  /** Every excerpt of one review together. */
  totalBytes: 192 * 1024,
} as const;
export type EvidenceLimits = { [K in keyof typeof EVIDENCE_LIMITS]: number };

export interface EvidenceFileMaterial {
  bytes: number;
  sha256: string;
  format: "text" | "go-test-json";
  excerpt: string;
  /** What was left out, in words; absent when the whole file is shown. */
  cut?: string;
}
export interface GateEvidenceMaterial {
  check: unknown;
  status: unknown;
  caseResults?: unknown;
  verifyExitCode?: unknown;
  verifyTimedOut?: unknown;
  completed?: unknown;
  observationsOverCap?: unknown;
  files: Record<string, EvidenceFileMaterial>;
}
/** One verified gate record: its ledger data and its evidence files' bytes, by evidence-relative name. */
export interface VerifiedGate { data: Record<string, unknown>; files: Record<string, { raw: Buffer; sha256: string }> }

export const EVIDENCE_NOTE = "Gate evidence is excerpted, not whole: each file shows its last part, or for go test -json output a summary (counts, every failing test with the end of its output, the final package lines). A file's \"cut\" says what was left out; bytes and sha256 describe the whole file the runner recorded.";

/** The UTF-8 size of a string as it is embedded in the review's JSON. */
export const jsonBytes = (text: string): number => Buffer.byteLength(JSON.stringify(text)) - 2;

/** How many characters from one end of `text` fit in `cap` bytes as JSON (escapes count). */
function fit(text: string, cap: number, part: (take: number) => string): number {
  let take = Math.max(0, Math.min(text.length, cap));
  for (;;) {
    const size = jsonBytes(part(take));
    if (size <= cap || take === 0) return take;
    take = Math.min(take - 1, Math.floor((take * cap) / size));
  }
}
/** The longest end of `text` whose JSON form fits in `cap` bytes. */
export function tailWithin(text: string, cap: number): string {
  if (jsonBytes(text) <= cap) return text;
  return text.slice(text.length - fit(text, cap, (take) => text.slice(text.length - take)));
}
/** The longest start of `text` whose JSON form fits in `cap` bytes. */
export function headWithin(text: string, cap: number): string {
  if (jsonBytes(text) <= cap) return text;
  return text.slice(0, fit(text, cap, (take) => text.slice(0, take)));
}

interface GoEvent { Action: string; Package?: unknown; Test?: unknown; Output?: unknown; ImportPath?: unknown }
const MODELED = new Set(["start", "run", "pause", "cont", "output", "pass", "fail", "skip", "bench", "build-output", "build-fail"]);

function goEvents(text: string): { events: GoEvent[]; other: string[] } | undefined {
  const events: GoEvent[] = [], other: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { value = undefined; }
    if (value && typeof value === "object" && typeof (value as GoEvent).Action === "string") events.push(value as GoEvent);
    else other.push(line);
    // Not go test output: decide early, without parsing a whole large log.
    if (events.length === 0 && other.length >= 20) return undefined;
  }
  return events.length && events.length >= other.length ? { events, other } : undefined;
}

/** A bounded reading of `go test -json` output: what a reviewer needs from a long passing or failing run. */
export function goTestSummary(text: string, cap: number, testOutputCap: number): string | undefined {
  const parsed = goEvents(text);
  if (!parsed) return undefined;
  const key = (e: GoEvent) => `${String(e.Package ?? e.ImportPath ?? "")}\u0000${e.Test === undefined ? "" : String(e.Test)}`;
  const final = new Map<string, string>(), outputs = new Map<string, string>(), unmodeled: string[] = [];
  const packageLines: string[] = [];
  for (const e of parsed.events) {
    const k = key(e);
    if (e.Action === "output" || e.Action === "build-output") {
      const out = typeof e.Output === "string" ? e.Output : "";
      // Keep only the end of each test's output: that is all a summary shows.
      outputs.set(k, ((outputs.get(k) ?? "") + out).slice(-testOutputCap * 2));
      if (e.Test === undefined && out.trim() !== "") { packageLines.push(out.replace(/\n$/, "")); if (packageLines.length > 40) packageLines.shift(); }
    } else if (e.Action === "pass" || e.Action === "fail" || e.Action === "skip") final.set(k, e.Action);
    else if (e.Action === "build-fail") final.set(k, "fail");
    else if (!MODELED.has(e.Action)) { unmodeled.push(JSON.stringify(e)); if (unmodeled.length > 20) unmodeled.shift(); }
  }
  const count = (tests: boolean, action: string) => [...final].filter(([k, a]) => (k.endsWith("\u0000") !== tests) && a === action).length;
  const failed = [...final].filter(([, a]) => a === "fail").map(([k]) => k);
  const failedTests = failed.filter((k) => !k.endsWith("\u0000")), failedPackages = failed.filter((k) => k.endsWith("\u0000"));
  const name = (k: string) => k.replace("\u0000", " ").trim();
  const lines = [
    `go test -json summary of ${parsed.events.length} events: packages ${count(false, "pass")} passed, ${count(false, "fail")} failed, ${count(false, "skip")} skipped; tests ${count(true, "pass")} passed, ${failedTests.length} failed, ${count(true, "skip")} skipped.`,
  ];
  const sections: string[] = [];
  if (failedTests.length) {
    sections.push(`Failed tests (${failedTests.length}):`);
    for (const k of failedTests) sections.push(`--- FAIL ${name(k)}\n${tailWithin(outputs.get(k) ?? "", testOutputCap).replace(/\n$/, "")}`);
  }
  if (failedPackages.length) {
    sections.push(`Failed packages (${failedPackages.length}):`);
    for (const k of failedPackages) sections.push(`--- FAIL ${name(k)}\n${tailWithin(outputs.get(k) ?? "", testOutputCap).replace(/\n$/, "")}`);
  }
  if (unmodeled.length) sections.push(`Other events (last ${unmodeled.length}):\n${unmodeled.join("\n")}`);
  if (parsed.other.length) sections.push(`Lines that are not go test events (last 20 of ${parsed.other.length}):\n${parsed.other.slice(-20).join("\n")}`);
  sections.push(`Final package lines:\n${packageLines.join("\n")}`);
  // The counts first, then each section while it fits; a section that doesn't fit is named, not dropped silently.
  let out = lines[0]!;
  const left: number[] = [];
  for (const [i, s] of sections.entries()) {
    if (jsonBytes(`${out}\n${s}`) <= cap - 200) out = `${out}\n${s}`;
    else left.push(i);
  }
  if (left.length) out = headWithin(`${out}\n[${left.length} more section(s) not shown: the summary limit was reached]`, cap);
  return out;
}

const PRIORITY = (name: string) => name.startsWith("verify-") ? 0 : name.endsWith("/code") ? 1 : 2;

/** Bounded material for every verified gate of a review; `limits` is a test seam. */
export function gateMaterial(gates: readonly VerifiedGate[], limits: EvidenceLimits = EVIDENCE_LIMITS): GateEvidenceMaterial[] {
  let remaining = limits.totalBytes;
  const out = gates.map((g): GateEvidenceMaterial => {
    const d = g.data;
    return {
      check: d.check, status: d.status,
      ...(d.caseResults !== undefined ? { caseResults: d.caseResults } : {}),
      ...(d.verifyExitCode !== undefined ? { verifyExitCode: d.verifyExitCode } : {}),
      ...(d.verifyTimedOut !== undefined ? { verifyTimedOut: d.verifyTimedOut } : {}),
      ...(d.completed !== undefined ? { completed: d.completed } : {}),
      ...(d.observationsOverCap !== undefined ? { observationsOverCap: d.observationsOverCap } : {}),
      files: Object.create(null) as Record<string, EvidenceFileMaterial>,
    };
  });
  // The verdict lines first, then exit codes, then logs: when the total runs out, the logs go first.
  const order = gates.flatMap((g, i) => Object.keys(g.files).map((name) => ({ i, name }))).sort((a, b) => PRIORITY(a.name) - PRIORITY(b.name));
  for (const { i, name } of order) {
    const { raw, sha256 } = gates[i]!.files[name]!;
    const text = raw.toString("utf8");
    const base = { bytes: raw.length, sha256 };
    const cap = Math.min(remaining, limits.fileBytes);
    let file: EvidenceFileMaterial;
    const summary = raw.length > limits.fileBytes ? goTestSummary(text, Math.min(remaining, limits.goSummaryBytes), limits.goTestOutputBytes) : undefined;
    if (summary !== undefined && jsonBytes(summary) <= remaining) {
      file = { ...base, format: "go-test-json", excerpt: summary, cut: `a summary of all ${raw.length} bytes; each failing test shows the last ${limits.goTestOutputBytes} bytes of its output` };
    } else if (jsonBytes(text) <= cap) {
      file = { ...base, format: "text", excerpt: text };
    } else if (cap < 256) {
      file = { ...base, format: "text", excerpt: "", cut: `not shown: the review's evidence limit (${limits.totalBytes} bytes) was reached` };
    } else {
      const excerpt = tailWithin(text, cap);
      file = { ...base, format: "text", excerpt, cut: `showing the last ${Buffer.byteLength(excerpt)} of ${raw.length} bytes` };
    }
    remaining -= jsonBytes(file.excerpt);
    out[i]!.files[name] = file;
  }
  // Each gate's files in their recorded order, whatever order they were excerpted in.
  return out.map((g, i) => ({ ...g, files: Object.fromEntries(Object.keys(gates[i]!.files).map((name) => [name, g.files[name]!])) }));
}
