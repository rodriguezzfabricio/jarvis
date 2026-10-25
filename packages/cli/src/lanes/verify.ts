export interface ObservationVerification { ok: boolean; problems: string[] }
export interface WebExpectation { url: string; axeVersion: string }

const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** Install in checks/, never fixtures/. Only the isolated verify phase calls these assertions. */
export function verifyWebObservation(raw: unknown, expected: WebExpectation): ObservationVerification {
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
    verifyAxe(page.axe, expected, `${page.width}`, problems);
    verifyFrames(page, expected, problems);
  }
  if (seen.size !== widths.length && !problems.length) problems.push("missing viewport coverage");
  return { ok: problems.length === 0, problems };
}

function verifyFrames(page: Record<string, unknown>, expected: WebExpectation, problems: string[]): void {
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
    verifyAxe(frame.axe, expected, `${page.width} frame ${frame.id}`, problems);
  }
  if (tested.size !== ids.length) problems.push(`${page.width}: untested frame`);
}

function verifyAxe(raw: unknown, expected: WebExpectation, label: string, problems: string[]): void {
  const axe = object(raw);
  if (!axe || !Array.isArray(axe.violations) || !Array.isArray(axe.incomplete)) { problems.push(`${label}: missing axe results`); return; }
  if (!nonempty(expected.axeVersion) || axe.version !== expected.axeVersion) problems.push(`${label}: axe version differs from approved pin`);
  for (const issue of [...axe.violations, ...axe.incomplete]) {
    const item = object(issue);
    if (!item || !nonempty(item.id) || !["minor", "moderate", "serious", "critical", null].includes(item.impact as string | null)) problems.push(`${label}: malformed axe finding`);
    else if (item.impact === "serious" || item.impact === "critical" || item.impact === null) problems.push(`${label}: ${item.id} (${String(item.impact)}, requires resolution)`);
  }
}
