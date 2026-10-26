import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import type { Problem } from "../spec/parser.ts";
import { checkRepository, type RepositoryCheck } from "../spec/versions.ts";
import { DecisionRegister } from "./store.ts";

/** Mechanical references only. Whether prose contradicts a decision remains the fresh reader's job. */
export function checkSpecRegister(repo: string, source: string): Problem[] {
  const document = DecisionRegister.open(repo).read();
  const entries = new Map(document.entries.map((entry) => [entry.id, entry]));
  const ids = [...entries.keys()]; const problems: Problem[] = [];
  source.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, " ")).split(/\r?\n/).forEach((text, index) => {
    const line = index + 1;
    const range = /\bD(\d+)\s*[-–—]\s*D(\d+)\b/.exec(text);
    if (range && (/decisions?/i.test(text) || /^\s*#/.test(text))) {
      if (Number(range[1]) !== Math.min(...ids) || Number(range[2]) !== Math.max(...ids)) problems.push({ line, code: "decision-range", message: "Decision header range must match the complete current register" });
      return;
    }
    for (const match of text.matchAll(/\bD(\d+)\b/g)) {
      const entry = entries.get(Number(match[1]));
      if (!entry) problems.push({ line, code: "unknown-decision", message: `Unknown decision ${match[0]}` });
      else if (entry.status.kind === "superseded") problems.push({ line, code: "superseded-decision", message: `${match[0]} is superseded by D${entry.status.by}` });
    }
  });
  return problems;
}

/** Keep old versions as history; compare only the latest spec with today's register. */
export function checkSpecRepository(repo: string): RepositoryCheck {
  const result = checkRepository(repo);
  const latest = result.versions.at(-1);
  if (!latest) return result;
  try {
    const fd = openSync(latest.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let source: string;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error("Expected a regular, single-link spec file");
      source = readFileSync(fd, "utf8");
    } finally { closeSync(fd); }
    result.problems.push(...checkSpecRegister(repo, source).map((problem) => ({ ...problem, file: latest.path })));
  } catch (error) { result.problems.push({ file: latest.path, line: 1, code: "decision-register", message: String(error) }); }
  return { ...result, ok: result.problems.length === 0 };
}
