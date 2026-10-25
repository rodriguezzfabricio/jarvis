import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lintDesign, lintTokens } from "../../packages/cli/src/lanes/design.ts";
import { detectAiTells } from "../../packages/cli/src/lanes/tells.ts";

const design = readFileSync(new URL("../fixtures/qa/DESIGN.md", import.meta.url), "utf8");
const codes = (findings: { rule: string }[]) => findings.map(f => f.rule);

describe("DESIGN.md lint", () => {
  it("reads the filled template and resolves its tokens", () => {
    const result = lintDesign(design);
    expect(result.findings).toEqual([]);
    expect(result.tokens?.spacing).toEqual([0, 4, 8, 16, 24, 32]);
    expect(result.tokens?.fonts).toEqual(["Atkinson Hyperlegible", "Fraunces"]);
  });

  it("rejects missing sections, unfilled placeholders and malformed token values", () => {
    expect(codes(lintDesign(design.replace("## Layout", "## Grid")).findings)).toContain("design-section");
    expect(codes(lintDesign(design.replace('name: "Field Notes"', 'name: "<product>"')).findings)).toContain("design-placeholder");
    expect(codes(lintDesign(design.replace('primary: "#24543d"', 'primary: "purple"')).findings)).toContain("design-color");
    expect(codes(lintDesign(design.replace('sm: "8px"', 'sm: "banana"')).findings)).toContain("design-size");
    expect(codes(lintDesign(design.replace('fontSize: "16px"', 'fontSize: "big"')).findings)).toContain("design-type");
  });

  it("requires all token groups and validates reference types and existence", () => {
    expect(codes(lintDesign(design.replace("spacing:\n", "space:\n")).findings)).toContain("design-group");
    expect(codes(lintDesign(design.replace("{colors.primary}", "{colors.absent}")).findings)).toContain("design-reference");
    expect(codes(lintDesign(design.replace("{rounded.md}", "{colors.primary}")).findings)).toContain("design-reference-type");
    expect(codes(lintDesign(design.replace('backgroundColor: "{colors.primary}"', 'backgroundColor: "#24543d"')).findings)).toContain("design-component-literal");
    expect(lintDesign(design.replace('primary: "#24543d"', 'primary:')).tokens).toBeUndefined();
  });

  it("checks text contrast for component color pairs", () => {
    const bad = design.replace('on-primary: "#ffffff"', 'on-primary: "#24543d"');
    expect(codes(lintDesign(bad).findings)).toContain("design-contrast");
  });

  it("fails closed on duplicate keys and YAML features outside the scalar-map format", () => {
    for (const value of [design.replace("colors:\n", 'colors:\n  primary: "#ffffff"\n'), design.replace('primary: "#24543d"', 'primary: &accent "#24543d"'), design.replace('name: "Field Notes"', 'name: |\n  Field Notes')]) {
      expect(codes(lintDesign(value).findings)).toContain("design-format");
      expect(lintDesign(value).tokens).toBeUndefined();
    }
    expect(lintDesign("# no frontmatter").tokens).toBeUndefined();
  });
});

describe("token lint", () => {
  it("flags raw colors even when on palette, off-scale sizes and undeclared fonts with file:line", () => {
    const source = { path: "src/Card.tsx", content: 'const style = {\n color: "#24543d",\n padding: "13px",\n fontFamily: "Inter",\n borderRadius: "7px",\n fontSize: "17px"\n};' };
    const result = lintTokens([source], lintDesign(design).tokens!);
    expect(result.map(f => [f.rule, f.file, f.line])).toEqual([
      ["raw-color", "src/Card.tsx", 2], ["off-scale-spacing", "src/Card.tsx", 3], ["unknown-font", "src/Card.tsx", 4],
      ["off-scale-radius", "src/Card.tsx", 5], ["off-scale-type", "src/Card.tsx", 6],
    ]);
  });

  it("accepts references and scale values, and ignores comments and non-UI files", () => {
    expect(lintTokens([{ path: "src/a.css", content: '/* #123456 13px */\na { padding: 8px 16px; border-radius: 8px; font-family: "Atkinson Hyperlegible", sans-serif; font-size: 16px; color: var(--primary); }' }, { path: "README.md", content: "#123456 13px" }], lintDesign(design).tokens!)).toEqual([]);
  });

  it("handles Swift colors, sizes and custom fonts and React Native numeric styles", () => {
    const result = lintTokens([{ path: "ios/Card.swift", content: 'Color(hex: "24543D")\n.padding(13)\n.cornerRadius(7)\n.font(.custom("Inter", size: 17))' }, { path: "mobile/Card.tsx", content: 'const s = { padding: 13, borderRadius: 7, fontSize: 17 };' }], lintDesign(design).tokens!);
    expect(codes(result)).toEqual(expect.arrayContaining(["raw-color", "off-scale-spacing", "off-scale-radius", "off-scale-type", "unknown-font"]));
    expect(result.filter(f => f.file === "mobile/Card.tsx")).toHaveLength(3);
  });

  it("checks Tailwind arbitrary dimensions and colors", () => {
    expect(codes(lintTokens([{ path: "src/a.tsx", content: '<div className="p-[13px] rounded-[7px] text-[17px] bg-[#fff]" />' }], lintDesign(design).tokens!))).toEqual(["off-scale-spacing", "off-scale-radius", "off-scale-type", "raw-color"]);
  });

  it("catches Swift directional padding/system fonts, RN dimensions, and Tailwind font literals", () => {
    const result = lintTokens([
      { path: "ios/Card.swift", content: '.padding(.horizontal, 13)\n.font(.system(size: 16))' },
      { path: "mobile/Card.tsx", content: 'const s = { width: 13, borderRadius: -8 };' },
      { path: "src/a.tsx", content: `<div className="font-['Inter']" />` },
    ], lintDesign(design).tokens!);
    expect(result.filter(f => f.file === "ios/Card.swift").map(f => f.rule)).toEqual(["off-scale-spacing", "unknown-font"]);
    expect(result.filter(f => f.file === "mobile/Card.tsx").map(f => f.rule)).toEqual(["off-scale-spacing", "off-scale-radius"]);
    expect(result.filter(f => f.file === "src/a.tsx").map(f => f.rule)).toEqual(["unknown-font"]);
  });

  it("allows a declared typeface in a JS object with other properties", () => {
    expect(lintTokens([{ path: "src/a.tsx", content: 'const style = { fontFamily: "Fraunces", padding: "8px" };' }], lintDesign(design).tokens!)).toEqual([]);
  });
});

describe("deterministic AI tells", () => {
  it("fails the generic negative control and passes a grounded screen", () => {
    const bad = readFileSync(new URL("../fixtures/qa/generic.html", import.meta.url), "utf8");
    expect(codes(detectAiTells([{ path: "screen.html", content: bad }]))).toEqual(expect.arrayContaining(["purple-gradient", "emoji-icon", "generic-copy", "default-font", "submit-copy", "apologetic-error", "multiple-primary", "launch-tour"]));
    const good = readFileSync(new URL("../fixtures/qa/grounded.html", import.meta.url), "utf8");
    expect(detectAiTells([{ path: "screen.html", content: good }])).toEqual([]);
  });

  it("supports hex and Tailwind gradients and cheap template-chrome checks", () => {
    const result = detectAiTells([{ path: "src/a.tsx", content: '<main className="bg-gradient-to-r from-purple-500 to-blue-500"><p className="eyebrow">FOR EVERYONE</p><p>A · B · C</p><button>Add →</button><button>Save →</button></main>\na { background: linear-gradient(#8b5cf6, #2563eb); }' }]);
    expect(codes(result)).toEqual(expect.arrayContaining(["purple-gradient", "eyebrow", "meta-line", "button-arrows"]));
  });

  it("uses reviewed exceptions only, keeps inherited lines out, and never obeys source ignores", () => {
    const source = { path: "src/a.html", content: '<h1>Welcome to your dashboard</h1>\n<!-- jarvis-ignore generic-copy -->\n<h2>Scale without limits</h2>' };
    expect(detectAiTells([source], { changedLines: { "src/a.html": [{ start: 3, end: 3 }] } })).toHaveLength(1);
    expect(detectAiTells([source], { exceptions: [{ rule: "generic-copy", reason: 'Brief says "Welcome to your dashboard"', source: "docs/spec/v1.md#copy" }] })).toEqual([]);
    expect(() => detectAiTells([source], { exceptions: [{ rule: "generic-copy", reason: "", source: "" }] })).toThrow();
    expect(detectAiTells([source])).toHaveLength(2);
  });

  it("does not flag emoji in prose, comments or non-markup files", () => {
    expect(detectAiTells([{ path: "src/a.html", content: '<!-- Welcome to your dashboard --><p>A note about 🐝 bees.</p>' }, { path: "docs/guide.md", content: "Welcome to your dashboard" }])).toEqual([]);
  });
});
