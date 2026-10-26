/**
 * The paths a review that asks for fixes may name (decision 126): its report, and the files its findings
 * point at. No imports, so triage can check a typed report path without loading the runner.
 */

/** The report a review writes when the request asks for fixes but names no file. */
export const DEFAULT_REVIEW_REPORT = "REVIEW.md";

const METADATA = new Set([".git", ".jarvis"]);

/** Why `path` isn't a plain repo-relative path outside git and runner metadata, or undefined when it is. */
export function repoPathProblem(path: string, max = 1000): string | undefined {
  if (typeof path !== "string" || path.length === 0) return "the path is empty";
  if (path.length > max) return `the path is longer than ${max} characters`;
  if (/[\\\x00-\x1f\x7f:*?"<>|`]/.test(path)) return "the path has a character a plain path doesn't";
  if (path.startsWith("/")) return "the path is absolute: it must be inside the checkout";
  const parts = path.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return "the path leaves the checkout or isn't plain";
  if (parts.some((p) => METADATA.has(p.toLowerCase()))) return "the path is in git or runner metadata";
  return undefined;
}

/**
 * Markdown names that something other than a person reads: package builds (README, CHANGELOG, LICENSE), agent
 * harnesses (AGENTS, CLAUDE, GEMINI and the like), Jarvis's own skills and product files, and repository policy.
 */
const READ_BY_TOOLS = /^(?:readme|changelog|history|license|licence|copying|notice|agents|claude|gemini|copilot-instructions|conventions|design|product|skill|security|contributing|code_of_conduct|codeowners)(?:\.[a-z]+)?$/i;
/** A .txt report must say what it is, so it can never be a build or config input such as requirements.txt or CMakeLists.txt. */
const TXT_REPORT = /(?:review|finding|report|audit)/i;

/**
 * Why `path` can't be a review's report, or undefined when it can (decision 126). The runner commits the report
 * without a gate, so it may only be a plain .md, .markdown or .txt file that nothing but a person reads:
 * - no git pattern characters ([ ] { } ! * ?), so a pathspec can't widen it to other files;
 * - no hidden folder or file (tool configuration lives there), and not Jarvis's approved specs (docs/spec/);
 * - no Markdown name that builds, agents or Jarvis read (README, CLAUDE.md, DESIGN.md …);
 * - a .txt report's name says review, finding, report or audit.
 */
export function reportPathProblem(path: string): string | undefined {
  const problem = repoPathProblem(path, 200);
  if (problem) return problem.replace("the path", "the report path");
  if (!/\.(?:md|markdown|txt)$/i.test(path)) return "the report must be a .md, .markdown or .txt file";
  if (/[[\]{}!*?]/.test(path)) return "the report path has a character git reads as a pattern";
  const parts = path.split("/");
  if (parts.some((p) => p.startsWith("."))) return "the report can't be in a hidden folder or be a hidden file (tool configuration lives there)";
  if (/^docs\/spec\//i.test(path)) return "the report can't be in docs/spec/, where Jarvis's approved specs live";
  const name = parts.at(-1)!;
  if (READ_BY_TOOLS.test(name)) return `the report can't be ${name}: builds, agents or Jarvis read files with that name`;
  if (/\.txt$/i.test(name) && !TXT_REPORT.test(name)) return "a .txt report's name must say review, finding, report or audit, so it can't be a build or config input";
  return undefined;
}
