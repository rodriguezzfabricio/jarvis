import { describe, expect, it } from "vitest";
import { verifyWebObservation } from "../../packages/cli/src/lanes/verify.ts";

const url = "http://localhost:3000/habits";
const observation = () => ({ kind: "qa-browser", url, pages: [375, 768, 1440].map(width => ({ width, url, accessibilityTree: "- button Add habit", axe: { version: "4.10.3", violations: [] as { id: string; impact: string }[], incomplete: [] }, screenshot: Buffer.from("fake-image").toString("base64") })) });

describe("protected browser verification", () => {
  it("accepts complete browser observations for the exact local target", () => {
    expect(verifyWebObservation(observation(), { url, axeVersion: "4.10.3" })).toEqual({ ok: true, problems: [] });
  });

  it("normalizes the expected URL without accepting a different path", () => {
    expect(verifyWebObservation({ ...observation(), url: "http://localhost:3000/", pages: observation().pages.map(p => ({ ...p, url: "http://localhost:3000/" })) }, { url: "http://localhost:3000", axeVersion: "4.10.3" }).ok).toBe(true);
  });

  it("rejects serious and critical violations and requires manual checks for incomplete high impact results", () => {
    const raw = observation();
    raw.pages[0]!.axe.violations.push({ id: "color-contrast", impact: "serious" });
    expect(verifyWebObservation(raw, { url, axeVersion: "4.10.3" })).toMatchObject({ ok: false, problems: [expect.stringContaining("color-contrast")] });
    raw.pages[0]!.axe.violations[0]!.impact = "critical";
    expect(verifyWebObservation(raw, { url, axeVersion: "4.10.3" }).ok).toBe(false);
    const incomplete = { ...observation(), pages: observation().pages.map(p => ({ ...p, axe: { version: "4.10.3", violations: [], incomplete: [{ id: "contrast-needs-review", impact: "serious" }] } })) };
    expect(verifyWebObservation(incomplete, { url, axeVersion: "4.10.3" }).ok).toBe(false);
  });

  it("never accepts missing, malformed, duplicate or wrong-target observations", () => {
    for (const raw of [null, {}, { ...observation(), url: "http://localhost:3000/other" }, { ...observation(), pages: [] }, { ...observation(), pages: [observation().pages[0], observation().pages[0], observation().pages[0]] }, { ...observation(), pages: observation().pages.map(p => ({ ...p, accessibilityTree: "" })) }, { ...observation(), pages: observation().pages.map(p => ({ ...p, axe: {} })) }, { ...observation(), pages: observation().pages.map(p => ({ ...p, screenshot: "" })) }]) {
      expect(verifyWebObservation(raw, { url, axeVersion: "4.10.3" }).ok).toBe(false);
    }
  });

  it("does not turn low impact findings into a serious-issue failure", () => {
    const raw = observation();
    raw.pages[0]!.axe.violations.push({ id: "minor", impact: "minor" });
    expect(verifyWebObservation(raw, { url, axeVersion: "4.10.3" }).ok).toBe(true);
  });
});
