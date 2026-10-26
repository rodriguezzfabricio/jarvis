import { describe, expect, it } from "vitest";
import { lintTokens, type DesignTokens } from "../../packages/cli/src/lanes/design.ts";
import { detectAiTells } from "../../packages/cli/src/lanes/tells.ts";

const tokens: DesignTokens = { colors: [], spacing: [0, 4, 8, 16], radii: [0, 4], typeScale: [16], fonts: [] };

describe("runtime detector regressions", () => {
  it("does not treat unitless CSS or JS line height as spacing", () => {
    expect(lintTokens([
      { path: "Card.css", content: "a { line-height: 1.45; }" },
      { path: "Card.tsx", content: "const style = { lineHeight: 1.45 };" },
    ], tokens)).toEqual([]);
  });

  it("still detects off-scale dimensions beside unitless line height", () => {
    expect(lintTokens([{ path: "Card.css", content: "a { line-height: 1.45; padding: 13px; height: 17px; }" }], tokens).map(f => f.rule)).toEqual(["off-scale-spacing", "off-scale-spacing"]);
    expect(lintTokens([{ path: "Card.tsx", content: "const style = { lineHeight: 1.45, height: 17, padding: 13 };" }], tokens)).toHaveLength(2);
  });

  it.each(["0.34, 1.56, 0.64, 1", "0.34, -0.1, 0.64, 1", "0.34, 0, 0.64, 1.05", "0.34, 0, 0.64, -0.05", "0.34, +1.01, 0.64, 1"])("detects either overshooting y control point: %s", curve => {
    expect(detectAiTells([{ path: "Card.css", content: `a { transition: all 200ms cubic-bezier(${curve}); }` }]).map(f => f.rule)).toEqual(["bouncy-easing"]);
  });

  it("allows bounded y values and preserves motion exceptions and changed-line scope", () => {
    const source = { path: "Card.css", content: "a { transition: all 200ms cubic-bezier(0.34, 1.56, 0.64, 1); }" };
    expect(detectAiTells([{ ...source, content: source.content.replace("1.56", "1.0") }])).toEqual([]);
    expect(detectAiTells([source], { changedLines: { "Card.css": [{ start: 2, end: 2 }] } })).toEqual([]);
    expect(detectAiTells([source], { exceptions: [{ rule: "bouncy-easing", reason: "Playful motion requested", source: "brief" }] })).toEqual([]);
  });
});
