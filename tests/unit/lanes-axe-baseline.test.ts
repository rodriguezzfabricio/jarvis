import { describe, expect, it } from "vitest";
import { recordWebBaseline, verifyWebObservation, type WebBaseline } from "../../packages/cli/src/lanes/verify.ts";

const expected = { url: "http://localhost:3000/jobs", axeVersion: "4.10.3" };
const revision = "a".repeat(40);
const issue = (targets = [".old"], id = "color-contrast", impact = "serious") => ({ id, impact, nodes: targets.map(target => ({ target: [target] })) });
const axe = (violations = [issue()]) => ({ version: expected.axeVersion, violations, incomplete: [] as ReturnType<typeof issue>[] });
const observation = (violations = [issue()]) => ({ kind: "qa-browser", url: expected.url, pages: [375, 768, 1440].map(width => ({ width, url: expected.url, accessibilityTree: "- main Jobs", screenshot: "aW1hZ2U=", axe: axe(violations), frameCount: 1, frameIds: ["random-main-id"], frames: [{ id: "random-main-id", url: expected.url, axe: axe(violations) }] })) });
const verify = (raw: unknown, baseline: WebBaseline) => verifyWebObservation(raw, { ...expected, baseline });

describe("runner-recorded axe starting revision allowance", () => {
  it("allows unchanged serious and critical nodes from the runner's base revision", () => {
    const raw = observation([issue(), issue(["#label"], "label-content-name-mismatch", "critical")]);
    const baseline = recordWebBaseline(raw, expected, revision);
    expect(baseline.baseRevision).toBe(revision);
    expect(verify(raw, baseline)).toEqual({ ok: true, problems: [] });
    expect(verify(observation([]), baseline).ok).toBe(true);
    expect(verifyWebObservation(raw, expected).ok).toBe(false);
  });

  it("allows fewer baseline nodes but rejects new selectors, rules and a growing node count", () => {
    const baseline = recordWebBaseline(observation([issue([".old", ".other"])]), expected, revision);
    expect(verify(observation(), baseline).ok).toBe(true);
    for (const violations of [[issue([".old", ".new"])], [issue([".old"], "new-rule")], [issue([".old", ".other", ".old"])]]) {
      expect(verify(observation(violations), baseline).ok).toBe(false);
    }
  });

  it("does not allow a serious baseline node to become critical", () => {
    const baseline = recordWebBaseline(observation(), expected, revision);
    expect(verify(observation([issue([".old"], "color-contrast", "critical")]), baseline).ok).toBe(false);
  });

  it("keeps viewport and frame allowances separate while ignoring transient CDP frame IDs", () => {
    const base = observation([]); base.pages[0]!.frames[0]!.axe.violations.push(issue());
    const baseline = recordWebBaseline(base, expected, revision);
    const candidate = observation([]); candidate.pages[0]!.frames[0]!.axe.violations.push(issue());
    candidate.pages[0]!.frameIds = ["new-id"]; candidate.pages[0]!.frames[0]!.id = "new-id";
    expect(verify(candidate, baseline).ok).toBe(true);
    candidate.pages[1]!.frames[0]!.axe.violations.push(issue());
    expect(verify(candidate, baseline).ok).toBe(false);
  });

  it("never accepts an allowance embedded in candidate output or a forged baseline object", () => {
    const raw = observation();
    expect(verifyWebObservation({ ...raw, baseline: raw, baselinePath: "candidate/axe-baseline.json" }, expected).ok).toBe(false);
    expect(verify(raw, JSON.parse(JSON.stringify({ baseRevision: revision, observation: raw }))).ok).toBe(false);
    const baseline = recordWebBaseline(observation([]), expected, revision);
    expect(verify({ ...raw, baseline: raw }, baseline).ok).toBe(false);
  });

  it("snapshots baseline data and binds it to the target and axe pin", () => {
    const base = observation(), baseline = recordWebBaseline(base, expected, revision);
    base.pages[0]!.axe.violations.push(issue([".new"], "new-rule"));
    expect(verify(observation([issue([".new"], "new-rule")]), baseline).ok).toBe(false);
    expect(verifyWebObservation(observation(), { ...expected, axeVersion: "9.0.0", baseline }).ok).toBe(false);
    expect(verifyWebObservation(observation(), { ...expected, url: "http://localhost:3000/other", baseline }).ok).toBe(false);
  });

  it("rejects incomplete, malformed and wrong-pin base observations", () => {
    const incomplete = observation(); incomplete.pages[0]!.axe.incomplete.push(issue());
    const malformed = observation(); malformed.pages[0]!.axe.violations[0]!.nodes = [];
    const missingTargets = observation(); missingTargets.pages[0]!.axe.violations[0]!.nodes[0]!.target = [];
    for (const raw of [null, { ...observation(), pages: [] }, incomplete, malformed, missingTargets]) {
      expect(() => recordWebBaseline(raw, expected, revision)).toThrow();
    }
    expect(() => recordWebBaseline(observation(), { ...expected, axeVersion: "0.0.0" }, revision)).toThrow();
    expect(() => recordWebBaseline(observation(), expected, "HEAD")).toThrow();
  });

  it("does not suppress incomplete results or malformed candidate nodes", () => {
    const baseline = recordWebBaseline(observation(), expected, revision);
    const incomplete = observation(); incomplete.pages[0]!.axe.incomplete.push(issue());
    expect(verify(incomplete, baseline).ok).toBe(false);
    const malformed = observation(); malformed.pages[0]!.axe.violations[0]!.nodes = [];
    expect(verify(malformed, baseline).ok).toBe(false);
  });
});
