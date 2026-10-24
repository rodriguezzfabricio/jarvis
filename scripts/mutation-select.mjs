// Picks the test files that can observe a mutated file, so the mutation check doesn't run the whole
// suite for every mutation. Sound by construction: a subset only ever keeps a catch; anything else is
// re-run on the full suite, so a missed test costs time, never a false "caught" (scripts/mutation-check.mjs).
import { posix } from "node:path";

/**
 * Files whose text can make a test depend on another file: code, and JSON that names commands someone
 * runs (the fake claude runs hooks.json's hooks). Markdown is a leaf: reading it doesn't run what it
 * names. So is package.json: only a package manager runs its scripts, and no unit test runs one.
 */
const REFERRER = /\.(ts|mts|cts|js|mjs|cjs|json|sh)$/;
const LEAF = /(^|\/)package\.json$/;
const IMPORT = /\b(?:from|import|require)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g;
// Text that can't make code depend on a file: whole-line comments, and type-only imports, which Node's
// type stripping erases. Only line-leading comments, so a "//" inside a string (a URL) is left alone.
const INERT = [/^\s*(\/\/.*|\/?\*(?!.*\*\/\s*\S).*)$/gm, /^\s*(import|export)\s+type\s+(\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s*["'][^"']+["'];?/gm];

/** The text of a file with its inert parts blanked. */
export function liveText(text) {
  return INERT.reduce((t, re) => t.replace(re, ""), text);
}

/** A test file the mutation check may run. Anchor-applicability tests fail on every mutation by design. */
export function isCandidateTest(path) {
  return /^tests\/unit\/.+\.test\.ts$/.test(path) && !/-mutations\.test\.ts$/.test(path);
}

/** True if `text` names `path`: the repo path itself, or its basename as a whole name (not "mystore.ts"). */
export function mentions(text, path) {
  if (text.includes(path)) return true;
  const base = posix.basename(path);
  for (let i = text.indexOf(base); i !== -1; i = text.indexOf(base, i + 1)) {
    if (!/[\w-]/.test(text[i - 1] ?? "") && !/\w/.test(text[i + base.length] ?? "")) return true;
  }
  return false;
}

/**
 * Edges from each referrer (code, JSON other than package.json) to the files it imports (static,
 * re-export, literal dynamic) and to every tracked file it names, which covers files a test spawns
 * (hooks, scripts, fake claude, cli.ts) or reads (skills, templates). Leaves have no outgoing edges.
 * @param {string[]} files repo-relative tracked paths
 * @param {(path: string) => string | undefined} read
 * @returns {Map<string, Set<string>>}
 */
export function buildGraph(files, read) {
  const known = new Set(files);
  const graph = new Map(files.map((f) => [f, new Set()]));
  for (const f of files) {
    if (!REFERRER.test(f) || LEAF.test(f)) continue;
    const raw = read(f);
    if (typeof raw !== "string") continue;
    const out = graph.get(f);
    // A relative import that resolves names exactly one file; take it out of the text so its basename
    // doesn't also match every other file of that name ("./store.ts" is not decisions/store.ts).
    const text = liveText(raw).replace(IMPORT, (whole, spec) => {
      const target = posix.normalize(posix.join(posix.dirname(f), spec));
      if (!known.has(target)) return whole;
      out.add(target);
      return "";
    });
    for (const g of files) if (g !== f && mentions(text, g)) out.add(g);
  }
  return graph;
}

/**
 * The candidate tests from which `target` is reachable (itself included), plus `extra` (Vitest's own
 * import-graph answer), sorted. Non-candidates are dropped from both.
 */
export function relatedTests(target, graph, tests, extra = []) {
  const reached = tests.filter((t) => {
    const seen = new Set([t]);
    const queue = [t];
    while (queue.length) {
      const f = queue.shift();
      if (f === target) return true;
      for (const g of graph.get(f) ?? []) if (!seen.has(g)) seen.add(g), queue.push(g);
    }
    return false;
  });
  return [...new Set([...reached, ...extra])].filter(isCandidateTest).sort();
}

/** The repo-relative test files a Vitest JSON report ran, sorted. */
export function collectedFiles(report, root) {
  return report.testResults.map((r) => posix.relative(root, r.name)).sort();
}

/** The full control's test ids (mutation-classify's testIds) that belong to `files`. */
export function idsForFiles(ids, files) {
  const prefixes = files.map((f) => `${f.split("/").slice(-2).join("/")} > `);
  return ids.filter((id) => prefixes.some((p) => id.startsWith(p)));
}

/**
 * Runs `run(files, ...rest)` once per distinct set of test files (order-insensitive) and remembers
 * the result, a promise or an unusable (undefined) control included. `rest` (the clone to run in)
 * is not part of the key.
 */
export function controlCache(run) {
  const cache = new Map();
  return (files, ...rest) => {
    const sorted = [...files].sort();
    const key = sorted.join("\n");
    if (!cache.has(key)) cache.set(key, run(sorted, ...rest));
    return cache.get(key);
  };
}

/**
 * One mutation's verdict. The subset's verdict stands only if it is a catch measured against the
 * subset's own clean control; every other outcome is the full suite's verdict, as before the subset
 * existed. Runners may return promises.
 * @param {{ tests: string[], control: (tests: string[]) => unknown, runSubset: (tests: string[], control: unknown) => unknown, runFull: () => unknown }} args
 * @returns {Promise<{ kind: string, detail: string, scope: string }>}
 */
export async function judge({ tests, control, runSubset, runFull }) {
  const files = `${tests.length} test file${tests.length === 1 ? "" : "s"}`;
  const full = async (scope) => ({ ...(await runFull()), scope });
  if (tests.length === 0) return full("full suite, no related test file");
  const c = await control(tests);
  if (!c) return full(`full suite, the ${files}' control wasn't clean`);
  const k = await runSubset(tests, c);
  if (k.kind === "caught") return { kind: k.kind, detail: k.detail, scope: `${tests.length} of the suite's test files` };
  return full(`full suite, after ${files} ${k.kind === "survived" ? "survived" : "gave an error"}`);
}
