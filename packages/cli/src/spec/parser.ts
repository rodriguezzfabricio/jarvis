import { basename } from "node:path";

/** The restricted Markdown contract shared with templates/spec.md; this checks form, not approval. */
export const SECTIONS = ["Goals", "Non-goals", "User stories", "Acceptance criteria", "Assumptions", "Open questions"] as const;
type Section = (typeof SECTIONS)[number];
export type Status = "draft" | "confirmed" | "unconfirmed";
export type Priority = "P1" | "P2" | "P3";
export type AssumptionKind = "fixed" | "delegated";

export interface Problem {
  line: number;
  code: string;
  message: string;
}

interface Entry {
  id: string;
  text: string;
  details: string;
  line: number;
}
export interface Story extends Entry { priority: Priority }
export interface Criterion extends Entry { storyId: string }
export interface Assumption extends Entry { kind: AssumptionKind }

export interface Spec {
  version: number | null;
  headingLine: number | null;
  date: string | null;
  status: Status | null;
  supersedes: number | null;
  goals: string[];
  nonGoals: string[];
  stories: Story[];
  criteria: Criterion[];
  assumptions: Assumption[];
  openQuestions: string[];
}
export interface ParsedSpec { spec: Spec; problems: Problem[] }
export interface CheckResult extends ParsedSpec { ok: boolean }

function positive(raw: string): number | null {
  const n = Number(raw);
  return /^[1-9]\d*$/.test(raw) && Number.isSafeInteger(n) ? n : null;
}

function validDate(raw: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const date = new Date(`${raw}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === raw;
}

function excerpt(value: string): string {
  return value.slice(0, 80);
}

export function parseSpec(text: string): ParsedSpec {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const problems: Problem[] = [];
  const problem = (line: number, code: string, message: string) => problems.push({ line, code, message });
  const spec: Spec = { version: null, headingLine: null, date: null, status: null, supersedes: null, goals: [], nonGoals: [], stories: [], criteria: [], assumptions: [], openQuestions: [] };

  if (lines[0] !== "---") problem(1, "front-matter", "Expected --- as the first line.");
  const version = /^spec: (.+)$/.exec(lines[1] ?? "");
  spec.version = version ? positive(version[1]!) : null;
  if (spec.version === null) problem(2, "version", "Expected spec: N with a positive safe integer.");
  const date = /^date: (.+)$/.exec(lines[2] ?? "");
  if (date && validDate(date[1]!)) spec.date = date[1]!;
  else problem(3, "date", "Expected date: YYYY-MM-DD with a real calendar date.");
  const status = /^status: (draft|confirmed|unconfirmed)$/.exec(lines[3] ?? "");
  if (status) spec.status = status[1] as Status;
  else problem(4, "status", "Expected status: draft, confirmed or unconfirmed.");
  const supersedes = /^supersedes: (none|[1-9]\d*)$/.exec(lines[4] ?? "");
  const previous = supersedes?.[1];
  spec.supersedes = previous && previous !== "none" ? positive(previous) : null;
  if (!supersedes || (previous !== "none" && spec.supersedes === null)
    || (spec.version === 1 && previous !== "none")
    || (spec.version !== null && spec.version > 1 && spec.supersedes !== spec.version - 1)) {
    problem(5, "supersedes", "v1 must supersede none; each later version must supersede its immediate predecessor.");
  }
  if (lines[5] !== "---") problem(6, "front-matter", "Expected --- on line 6, with no extra metadata.");

  const sections = new Map<Section, { line: number; content: string[] }>();
  let current: Section | null = null;
  let lastSection = -1;
  let h1Count = 0;
  let lastEntry: Entry | null = null;
  let fence: { marker: string; count: number; line: number } | null = null;
  let inComment = false;
  const visible = (raw: string): string => {
    let result = "";
    let offset = 0;
    while (offset < raw.length) {
      if (inComment) {
        const end = raw.indexOf("-->", offset);
        if (end === -1) return result;
        offset = end + 3;
        inComment = false;
      } else {
        const start = raw.indexOf("<!--", offset);
        if (start === -1) return result + raw.slice(offset);
        result += raw.slice(offset, start);
        offset = start + 4;
        inComment = true;
      }
    }
    return result;
  };
  const appendDetails = (value: string) => {
    if (lastEntry) lastEntry.details += `${lastEntry.details ? "\n" : ""}${value}`;
  };

  const idValid = (id: string, prefix: string, line: number): boolean => {
    const raw = id.startsWith(prefix) ? id.slice(prefix.length) : "";
    if (positive(raw) !== null) return true;
    problem(line, "malformed-id", `Expected ${prefix} followed by a positive safe integer; got ${excerpt(id)}.`);
    return false;
  };

  for (let i = 6; i < lines.length; i++) {
    let raw = lines[i]!;
    const line = i + 1;
    if (fence) {
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(raw);
      appendDetails(raw);
      if (marker && marker[1]![0] === fence.marker && marker[1]!.length >= fence.count && !marker[2]!.trim()) fence = null;
      continue;
    }
    raw = visible(raw);
    const value = raw.trim();
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(raw);
    if (marker) {
      appendDetails(raw);
      fence = { marker: marker[1]![0]!, count: marker[1]!.length, line };
      continue;
    }
    const h1 = /^ {0,3}#(?:[ \t]+(.*))?$/.exec(raw);
    if (h1) {
      h1Count++;
      if (h1Count > 1 || sections.size > 0) problem(line, "h1", "Only one optional H1 is allowed, before the required sections.");
      if (raw !== `# Spec v${spec.version}`) problem(line, "heading-version", "The optional H1 must be # Spec vN matching the front matter.");
      if (h1Count === 1 && sections.size === 0) spec.headingLine = line;
      continue;
    }
    const h2 = /^ {0,3}##(?:[ \t]+(.*))?$/.exec(raw);
    if (h2) {
      lastEntry = null;
      const name = (h2[1] ?? "") as Section;
      const index = SECTIONS.indexOf(name);
      if (index === -1) {
        problem(line, "unknown-section", `Unexpected H2 heading: ${excerpt(name)}.`);
        current = null;
      } else {
        if (raw !== `## ${name}`) problem(line, "section-heading", "Required H2 headings must use their exact spelling without indentation.");
        if (sections.has(name)) problem(line, "duplicate-section", `Duplicate ${name} section.`);
        if (index < lastSection) problem(line, "section-order", `${name} is out of the required section order.`);
        lastSection = Math.max(lastSection, index);
        if (!sections.has(name)) sections.set(name, { line, content: [] });
        current = name;
      }
      continue;
    }
    if (/^ {0,3}#{3,6}(?:[ \t]+.*)?$/.test(raw)) {
      lastEntry = null;
      continue;
    }
    if (!value || !current) continue;
    const section = sections.get(current)!;
    section.content.push(value);
    const subBullet = /^[ \t]+(?:[-*+]|\d+[.)])\s+/.test(raw);
    const candidate = !subBullet && (/^(?:[-*+]|\d+[.)])\s+/.test(raw) || /THE SYSTEM SHALL|\*\*(?:S|AC|A)\d/.test(raw));
    if (current === "User stories" && candidate) {
      lastEntry = null;
      const m = /^- \*\*(\S+) \(([^)]+)\):\*\* (.*)$/.exec(value);
      if (!m) { problem(line, "story", "Expected - **S1 (P1):** As … with priority P1, P2 or P3."); continue; }
      const validId = idValid(m[1]!, "S", line);
      if (!/^P[123]$/.test(m[2]!) || !/^As\s+\S/.test(m[3]!)) {
        problem(line, "story", "A story needs priority P1, P2 or P3 and nonempty text starting with As.");
        continue;
      }
      if (validId) {
        const entry: Story = { id: m[1]!, priority: m[2] as Priority, text: m[3]!, details: "", line };
        spec.stories.push(entry);
        lastEntry = entry;
      }
    } else if (current === "Acceptance criteria" && candidate) {
      lastEntry = null;
      const m = /^- \*\*(\S+) \(([^)]+)\):\*\*(?: (.*))?$/.exec(value);
      if (!m) { problem(line, "criterion", "Expected - **AC1 (S1):** WHEN … THE SYSTEM SHALL …."); continue; }
      const validId = idValid(m[1]!, "AC", line);
      const validRef = idValid(m[2]!, "S", line);
      const body = (m[3] ?? "").trim();
      if (!/^WHEN\s+\S(?:.*\S)?\s+THE SYSTEM SHALL\s+\S.*$/.test(body)) {
        problem(line, "ears", "A criterion must be WHEN … THE SYSTEM SHALL … with a nonempty condition and result.");
      }
      if (validId && validRef) {
        const entry: Criterion = { id: m[1]!, storyId: m[2]!, text: body, details: "", line };
        spec.criteria.push(entry);
        lastEntry = entry;
      }
    } else if (current === "Assumptions" && candidate) {
      lastEntry = null;
      if (/^(?:[-*+]|\d+[.)])\s+None\.$/.test(value)) {
        problem(line, "assumption", "Write None. without the bullet when there are no assumptions.");
        continue;
      }
      const m = /^- \*\*(\S+) \[([^\]]+)\]:\*\*(?: (.*))?$/.exec(value);
      if (!m) { problem(line, "assumption", "Expected - **A1 [fixed]:** … or - **A1 [delegated]:** …."); continue; }
      const validId = idValid(m[1]!, "A", line);
      if (!/^(fixed|delegated)$/.test(m[2]!) || !m[3]?.trim()) {
        problem(line, "assumption", "An assumption needs kind fixed or delegated and a nonempty description.");
        continue;
      }
      if (validId) {
        const entry: Assumption = { id: m[1]!, kind: m[2] as AssumptionKind, text: m[3]!, details: "", line };
        spec.assumptions.push(entry);
        lastEntry = entry;
      }
    } else appendDetails(value);
  }
  if (fence) problem(fence.line, "fence", "Unclosed fenced code block.");

  for (const name of SECTIONS) {
    const section = sections.get(name);
    if (!section) { problem(1, "missing-section", `Missing required section: ${name}.`); continue; }
    const none = section.content.includes("None.");
    let nonempty = section.content.length > 0;
    if (name === "User stories") nonempty = spec.stories.length > 0;
    if (name === "Acceptance criteria") nonempty = spec.criteria.length > 0;
    if (name === "Assumptions") {
      nonempty = none || spec.assumptions.length > 0;
      if (none && spec.assumptions.length > 0) problem(section.line, "section-content", "Assumptions cannot combine None. with assumption entries.");
    }
    if (!nonempty) problem(section.line, "section-content", `${name} must be nonempty and use its required entry format.`);
  }
  spec.goals = sections.get("Goals")?.content ?? [];
  spec.nonGoals = sections.get("Non-goals")?.content ?? [];
  spec.openQuestions = sections.get("Open questions")?.content ?? [];

  for (const entries of [spec.stories, spec.criteria, spec.assumptions]) {
    const ids = new Set<string>();
    for (const entry of entries) {
      if (ids.has(entry.id)) problem(entry.line, "duplicate-id", `Duplicate ID: ${entry.id}.`);
      ids.add(entry.id);
    }
  }
  let priority = "P1";
  for (const story of spec.stories) {
    if (story.priority < priority) problem(story.line, "priority-order", "Stories must be listed in priority order P1, P2, P3.");
    priority = story.priority;
    if (!spec.criteria.some((c) => c.storyId === story.id)) problem(story.line, "story-without-criterion", `${story.id} has no acceptance criterion.`);
  }
  const storyIds = new Set(spec.stories.map((s) => s.id));
  for (const criterion of spec.criteria) {
    if (!storyIds.has(criterion.storyId)) problem(criterion.line, "unknown-story", `${criterion.id} refers to unknown story ${criterion.storyId}.`);
  }
  return { spec, problems: problems.sort((a, b) => a.line - b.line) };
}

export function checkSpec(text: string, filename?: string): CheckResult {
  const { spec, problems } = parseSpec(text);
  if (filename !== undefined) {
    const match = /^v([1-9]\d*)\.md$/.exec(basename(filename));
    if (!match || positive(match[1]!) !== spec.version) problems.push({ line: 2, code: "filename-version", message: "The file must be named vN.md and match spec: N." });
  }
  problems.sort((a, b) => a.line - b.line);
  return { spec, problems, ok: problems.length === 0 };
}
