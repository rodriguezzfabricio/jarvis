export interface ObservationVerification { ok: boolean; problems: string[] }
export interface WebExpectation { url: string; axeVersion: string; baseline?: WebBaseline }
declare const baselineBrand: unique symbol;
/** A process-local handle, created only from the runner's observation of the base revision. */
export interface WebBaseline { readonly baseRevision: string; readonly [baselineBrand]: true }
interface AxeRule { nodes: Set<string>; count: number }
interface AxeContext { recording: boolean; scopes: Map<string, Map<string, AxeRule>> }
interface BaselineData { url: string; axeVersion: string; scopes: AxeContext["scopes"] }
const baselines = new WeakMap<WebBaseline, BaselineData>();

const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** Install in checks/, never fixtures/. Only the isolated verify phase calls these assertions. */
export function verifyWebObservation(raw: unknown, expected: WebExpectation): ObservationVerification {
  let context: AxeContext | undefined;
  if (expected.baseline !== undefined) {
    const baseline = baselines.get(expected.baseline);
    let url: string;
    try { url = new URL(expected.url).href; } catch { return { ok: false, problems: ["invalid expected URL"] }; }
    if (!baseline || baseline.url !== url || baseline.axeVersion !== expected.axeVersion) return { ok: false, problems: ["invalid or wrong-target runner axe baseline"] };
    context = { recording: false, scopes: baseline.scopes };
  }
  return verifyObservation(raw, expected, context);
}

/** Call with runner-captured stdout from a fresh checkout of baseRevision, never a candidate file.
 * Across verify processes, retain that stdout outside fixtures/ in the approved checks and recreate
 * the handle there. A handle cannot be restored from a candidate's JSON or mutated by its caller.
 */
export function recordWebBaseline(raw: unknown, expected: WebExpectation, baseRevision: string): WebBaseline {
  if (!/^[a-f\d]{40}$/.test(baseRevision)) throw new Error("axe baseline needs the full base revision");
  const context: AxeContext = { recording: true, scopes: new Map() };
  const verified = verifyObservation(raw, expected, context);
  if (!verified.ok) throw new Error(`invalid base browser observation: ${verified.problems.join("; ")}`);
  const baseline = Object.freeze({ baseRevision }) as WebBaseline;
  baselines.set(baseline, { url: new URL(expected.url).href, axeVersion: expected.axeVersion, scopes: context.scopes });
  return baseline;
}

function verifyObservation(raw: unknown, expected: WebExpectation, context?: AxeContext): ObservationVerification {
  const problems: string[] = [];
  const observation = object(raw);
  let url: string;
  try { url = new URL(expected.url).href; }
  catch { return { ok: false, problems: ["invalid expected URL"] }; }
  if (!observation || observation.kind !== "qa-browser" || observation.url !== url || !Array.isArray(observation.pages)) return { ok: false, problems: ["missing or wrong-target browser observation"] };
  const widths = [375, 768, 1440];
  if (observation.pages.length !== widths.length) problems.push("expected all three viewport sizes");
  const seen = new Set<number>();
  for (const rawPage of observation.pages) {
    const page = object(rawPage);
    if (!page || typeof page.width !== "number" || !widths.includes(page.width) || seen.has(page.width)) { problems.push("missing, unexpected or duplicate viewport"); continue; }
    seen.add(page.width);
    if (page.url !== url) problems.push(`${page.width}: final page URL differs after redirect`);
    if (!nonempty(page.accessibilityTree)) problems.push(`${page.width}: missing accessibility tree`);
    if (!nonempty(page.screenshot) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(page.screenshot)) problems.push(`${page.width}: missing screenshot`);
    verifyAxe(page.axe, expected, `${page.width}`, problems, context);
    verifyFrames(page, expected, problems, context);
  }
  if (seen.size !== widths.length && !problems.length) problems.push("missing viewport coverage");
  return { ok: problems.length === 0, problems };
}

function verifyFrames(page: Record<string, unknown>, expected: WebExpectation, problems: string[], context?: AxeContext): void {
  const ids = page.frameIds;
  const frames = page.frames;
  if (!Number.isSafeInteger(page.frameCount) || Number(page.frameCount) < 1 || !Array.isArray(ids) || !ids.every(nonempty) || new Set(ids).size !== ids.length || ids.length !== page.frameCount || !Array.isArray(frames) || frames.length !== page.frameCount) {
    problems.push(`${page.width}: incomplete frame coverage`); return;
  }
  const tested = new Set<string>();
  for (const rawFrame of frames) {
    const frame = object(rawFrame);
    if (!frame || !nonempty(frame.id) || !ids.includes(frame.id) || tested.has(frame.id)) { problems.push(`${page.width}: unexpected or duplicate tested frame`); continue; }
    tested.add(frame.id);
    // CDP IDs and loader IDs change between launches; frame order and URL scope the allowance.
    verifyAxe(frame.axe, expected, `${page.width} frame ${frames.indexOf(rawFrame)} ${String(frame.url ?? "")}`, problems, context);
  }
  if (tested.size !== ids.length) problems.push(`${page.width}: untested frame`);
}

function verifyAxe(raw: unknown, expected: WebExpectation, label: string, problems: string[], context?: AxeContext): void {
  const axe = object(raw);
  if (!axe || !Array.isArray(axe.violations) || !Array.isArray(axe.incomplete)) { problems.push(`${label}: missing axe results`); return; }
  if (!nonempty(expected.axeVersion) || axe.version !== expected.axeVersion) problems.push(`${label}: axe version differs from approved pin`);
  const rules = new Map<string, AxeRule>();
  for (const issue of axe.violations) {
    const item = object(issue);
    if (!item || !nonempty(item.id) || !["minor", "moderate", "serious", "critical", null].includes(item.impact as string | null)) problems.push(`${label}: malformed axe finding`);
    else if (item.impact === null || ((item.impact === "serious" || item.impact === "critical") && !context)) problems.push(`${label}: ${item.id} (${String(item.impact)}, requires resolution)`);
    else if (item.impact === "serious" || item.impact === "critical") collectRule(item, rules, label, problems);
  }
  // Incomplete results still need manual resolution; they never create a baseline allowance.
  for (const issue of axe.incomplete) {
    const item = object(issue);
    if (!item || !nonempty(item.id) || !["minor", "moderate", "serious", "critical", null].includes(item.impact as string | null)) problems.push(`${label}: malformed axe finding`);
    else if (item.impact === "serious" || item.impact === "critical" || item.impact === null) problems.push(`${label}: ${item.id} (${String(item.impact)}, requires resolution)`);
  }
  if (context?.recording) context.scopes.set(label, rules);
  else if (context) {
    for (const [id, rule] of rules) {
      const baseline = context.scopes.get(label)?.get(id);
      if (!baseline || rule.count > baseline.count || [...rule.nodes].some(node => !baseline.nodes.has(node))) problems.push(`${label}: ${id} (new or increased axe violation)`);
    }
  }
}

function selector(value: unknown): boolean {
  return nonempty(value) || (Array.isArray(value) && value.length > 0 && value.every(selector));
}

function collectRule(item: Record<string, unknown>, rules: Map<string, AxeRule>, label: string, problems: string[]): void {
  if (!Array.isArray(item.nodes) || !item.nodes.length) { problems.push(`${label}: malformed axe nodes for ${String(item.id)}`); return; }
  const key = JSON.stringify([item.id, item.impact]);
  const rule = rules.get(key) ?? { nodes: new Set<string>(), count: 0 };
  for (const node of item.nodes) {
    const target = object(node)?.target;
    if (!Array.isArray(target) || !selector(target)) problems.push(`${label}: missing axe node selector for ${String(item.id)}`);
    else { rule.nodes.add(JSON.stringify(target)); rule.count++; }
  }
  rules.set(key, rule);
}
