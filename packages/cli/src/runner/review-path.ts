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

/** Why `path` can't be a review's report, or undefined when it can: a plain .md, .markdown or .txt file in the checkout. */
export function reportPathProblem(path: string): string | undefined {
  const problem = repoPathProblem(path, 200);
  if (problem) return problem.replace("the path", "the report path");
  if (!/\.(?:md|markdown|txt)$/i.test(path)) return "the report must be a .md, .markdown or .txt file";
  return undefined;
}
