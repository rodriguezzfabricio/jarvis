import { z } from "zod";
import { TASK_TYPES } from "../triage/triage.ts";

export const LANES = ["Architecture", "API", "Data", "UX/UI", "Security", "QA", "Performance"] as const;
export type Lane = (typeof LANES)[number];
export type CheckId = "dependency-cruiser" | "spectral" | "oasdiff" | "migration-up-down" | "restore" |
  "impeccable-source" | "impeccable-url" | "design-browser" | "ai-tells" | "token-lint" | "design-md-lint" | "axe" | "playwright" | "maestro" | "native-smoke" |
  "semgrep" | "gitleaks" | "osv-scanner" | "protected-checks" | "test-integrity" | "lighthouse-budgets" | "bundle-size" | "k6";
export interface LaneSelection { lane: Lane; files: string[]; checks: CheckId[] }

const path = z.string().min(1).max(4096).refine(p => !/[\\\x00-\x1f:]/.test(p) && !p.startsWith("/") && p.split("/").every(s => s !== "" && s !== "." && s !== ".."), "expected a repository-relative path without traversal");
const Input = z.object({
  type: z.enum([...TASK_TYPES, "sweep"]),
  changes: z.array(z.object({ path, oldPath: path.optional(), added: z.number().int().nonnegative(), deleted: z.number().int().nonnegative(), binary: z.boolean().optional() }).strict()),
  facts: z.object({
    dependencies: z.record(z.string(), z.string()).optional(),
    webRoots: z.array(path).optional(), iosRoots: z.array(path).optional(), desktopRoots: z.array(path).optional(),
    performanceFiles: z.array(path).optional(), securityFiles: z.array(path).optional(),
  }).strict(),
}).strict();
export type SelectionInput = z.input<typeof Input>;

const testFile = (p: string) => /(?:^|\/)(?:tests?|__tests__|fixtures)(?:\/|\.)|\.(?:test|spec)\./i.test(p);
const code = (p: string) => /\.(?:[cm]?[jt]sx?|svelte|vue|go|rs|py|rb|java|kt|swift|cs|c|cpp|h|sql|prisma|dart)$/i.test(p) && !testFile(p);
const manifest = (p: string) => /(?:^|\/)(?:package\.json|go\.mod|Cargo\.toml|pyproject\.toml|.*lock.*|.*\.csproj)$/i.test(p);
const api = (p: string) => /(?:^|\/)(?:api|handlers?|controllers?|endpoints?|openapi|swagger)(?:\/|\.)|(?:openapi|swagger)\.(?:ya?ml|json)$|\+server\.[jt]s$/i.test(p) && !testFile(p);
const data = (p: string) => /(?:^|\/)(?:migrations?|schemas?|models?)(?:\/|\.)|\.(?:sql|prisma)$/i.test(p) && !testFile(p);
const under = (p: string, roots: string[] = []) => roots.some(r => p === r || p.startsWith(`${r}/`));
const designContract = (p: string) => /(?:^|\/)DESIGN\.md$/.test(p);

function platform(p: string, facts: SelectionInput["facts"]): "web" | "ios" | "desktop" {
  const roots = ([['desktop', facts.desktopRoots], ['ios', facts.iosRoots], ['web', facts.webRoots]] as const)
    .flatMap(([target, paths]) => (paths ?? []).filter(root => under(p, [root])).map(root => ({ target, root })))
    .sort((a, b) => b.root.length - a.root.length);
  if (roots[0]) return roots[0].target;
  if (/(?:^|\/)(?:src-tauri|desktop|macos)(?:\/|$)/i.test(p)) return "desktop";
  if (/(?:^|\/)(?:web|www)(?:\/|$)/i.test(p)) return "web";
  if (/(?:^|\/)(?:ios|mobile|native)(?:\/|$)|\.swift$/i.test(p)) return "ios";
  return "web";
}

function ui(p: string, facts: SelectionInput["facts"]): boolean {
  const script = /\.[cm]?[jt]s$/i.test(p);
  const root = under(p, facts.webRoots) || under(p, facts.iosRoots) || under(p, facts.desktopRoots) || /(?:^|\/)(?:web|www|ios|mobile|native|desktop|macos|components|design-system|src\/lib)(?:\/|$)/i.test(p);
  const frameworkSource = p.startsWith("src/") && ["react", "svelte", "vue", "next", "expo", "react-native"].some(name => facts.dependencies?.[name]);
  return designContract(p) || /\.(?:tsx|jsx|svelte|vue|html?|css|scss|sass|less|swift|xib|storyboard|dart)$/i.test(p) || /(?:^|\/)src-tauri\//.test(p) || (script && (root || frameworkSource));
}

/** Pure routing; facts help interpret a touched file, and never activate unrelated repository areas. */
export function selectLanes(raw: SelectionInput): LaneSelection[] {
  const input = Input.parse(raw);
  if (["question", "review", "release"].includes(input.type)) return [];
  const files = [...new Set(input.changes.flatMap(c => c.oldPath ? [c.oldPath, c.path] : [c.path]))].sort();
  if (!files.length) return [];
  const scopes = new Map<Lane, string[]>();
  const add = (lane: Lane, predicate: (p: string) => boolean) => {
    const touched = files.filter(predicate);
    if (touched.length) scopes.set(lane, touched);
  };
  add("Architecture", p => manifest(p) || (input.type === "refactor" && code(p)) || (input.type === "new-product" && code(p)) || /(?:^|\/)(?:architecture|adr|decisions)(?:\/|\.)/.test(p));
  add("API", api);
  add("Data", data);
  add("UX/UI", p => ui(p, input.facts));
  add("Security", p => manifest(p) || api(p) || data(p) || code(p) || /\.(?:tsx|jsx|svelte|vue)$/i.test(p) ||
    /(?:^|\/)(?:auth|security|outreach|permissions|Dockerfile)(?:\/|\.|$)/i.test(p) || /(^|\/)[\w.-]*compose[\w.-]*\.ya?ml$/i.test(p) || input.facts.securityFiles?.includes(p) === true);
  add("QA", () => true);
  add("Performance", p => /(?:^|\/)(?:cache|performance|benchmarks?|perf)(?:\/|\.)/i.test(p) || input.facts.performanceFiles?.includes(p) === true);
  return LANES.flatMap(lane => {
    const scope = scopes.get(lane);
    return scope ? [{ lane, files: scope, checks: checks(lane, scope, input.facts) }] : [];
  });
}

function checks(lane: Lane, files: string[], facts: SelectionInput["facts"]): CheckId[] {
  switch (lane) {
    case "Architecture": return ["dependency-cruiser"];
    case "API": return ["spectral", "oasdiff"];
    case "Data": return ["migration-up-down", "restore"];
    case "Security": return ["semgrep", "gitleaks", "osv-scanner"];
    case "QA": return ["protected-checks", "test-integrity"];
    case "Performance": return files.some(api) ? ["k6"] : ["lighthouse-budgets", "bundle-size"];
    case "UX/UI": {
      if (files.every(designContract)) return ["design-md-lint"];
      const targets = new Set(files.filter(p => !designContract(p)).map(p => platform(p, facts)));
      const browser = targets.has("web") || targets.has("desktop") || files.some(p => /\.[cm]?[jt]sx?$/i.test(p));
      return ["impeccable-source", "ai-tells", "token-lint", "design-md-lint",
        // design-browser: the runner's own browser evidence for the design reviewer (decision 124).
        ...(browser ? ["impeccable-url", "design-browser", "axe", "playwright"] as const : []),
        ...(targets.has("ios") ? ["maestro"] as const : []), ...(targets.has("desktop") ? ["native-smoke"] as const : [])];
    }
  }
}
