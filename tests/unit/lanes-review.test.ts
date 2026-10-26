import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { selectLanes } from "../../packages/cli/src/lanes/selection.ts";
import { lintDesign, lintTokens } from "../../packages/cli/src/lanes/design.ts";
import { detectAiTells } from "../../packages/cli/src/lanes/tells.ts";
import { ordered } from "../../packages/cli/src/lanes/source.ts";
import { verifyWebObservation } from "../../packages/cli/src/lanes/verify.ts";

const tokens = lintDesign(readFileSync("tests/fixtures/qa/DESIGN.md", "utf8")).tokens!;
const select = (files: string[], facts = {}) => selectLanes({ type: "bug", facts, changes: files.map(path => ({ path, added: 2, deleted: 1 })) });
const ui = (files: string[], facts = {}) => select(files, facts).find(l => l.lane === "UX/UI");
const rules = (files: {path: string; content: string}[]) => lintTokens(files, tokens).map(f => f.rule);

describe("review: lane coverage cannot be bypassed with file names", () => {
  it.each(["web/src/lib/enrichment.ts", "web/src/a.js", "ios/helpers.ts", "desktop/view.js", "src/lib/cardTags.ts", "components/format.ts", "design-system/colors.js", "custom/presenter.ts"])("selects UI for %s", path => {
    expect(ui([path], { webRoots: ["custom"] })?.checks).toEqual(expect.arrayContaining(["axe", "playwright", "token-lint"]));
  });
  it.each(["api/Button.svelte", "fixtures/Card.vue", "Test.svelte", "api/Widget.tsx"])("does not let %s hide UI", path => {
    expect(ui([path])?.checks).toEqual(expect.arrayContaining(["axe", "playwright", "token-lint"]));
  });
  it("keeps both Impeccable scans in the UI gate", () => {
    expect(ui(["src/Card.tsx"])?.checks).toEqual(expect.arrayContaining(["impeccable-source", "impeccable-url"]));
  });
  it("gives the design reviewer its browser evidence wherever a browser scan runs (decision 124)", () => {
    expect(ui(["src/Card.tsx"])?.checks).toEqual(expect.arrayContaining(["impeccable-url", "design-browser"]));
    expect(ui(["DESIGN.md"])?.checks).toEqual(["design-md-lint"]);
    expect(ui(["ios/Today.swift"])?.checks).not.toContain("design-browser");
  });
  it.each(["docker-compose.yml", "ops/production.compose.yaml", "compose.override.yml", "Dockerfile"])("selects Security for %s alone", path => {
    expect(select([path]).map(l => l.lane)).toContain("Security");
  });
  it.each(["src/Page.tsx", "src/Page.svelte", "src/Page.vue"])("selects Security for web component %s", path => {
    expect(select([path]).map(l => l.lane)).toContain("Security");
  });
  it("honors an explicit security scope for otherwise inert assets", () => {
    expect(select(["assets/icon.svg"]).map(l => l.lane)).not.toContain("Security");
    expect(select(["assets/icon.svg"], { securityFiles: ["assets/icon.svg"] }).map(l => l.lane)).toContain("Security");
  });
  it("classifies mixed platforms by roots and paths", () => {
    const result = select(["src/App.tsx", "apps/phone/View.tsx"], { dependencies: { expo: "54", react: "19" }, iosRoots: ["apps/phone"] });
    expect(result.find(l => l.lane === "UX/UI")?.checks).toEqual(expect.arrayContaining(["axe", "playwright", "maestro"]));
    expect(ui(["src/App.tsx"])?.checks).not.toContain("maestro");
    expect(ui(["src/App.tsx"], { dependencies: { expo: "54", react: "19" } })?.checks).not.toContain("maestro");
  });
  it("uses the most specific explicit platform root", () => {
    const facts = { webRoots: ["src"], iosRoots: ["src/phone"] };
    expect(ui(["src/phone/View.swift"], facts)?.checks).toContain("maestro");
    expect(ui(["src/App.tsx"], facts)?.checks).toContain("playwright");
  });
  it("rejects obsolete unused repository flags", () => {
    for (const fact of ["designMd", "openapi", "migrations", "ios"]) expect(() => select(["src/App.tsx"], { [fact]: true })).toThrow();
  });
});

describe("review: language-aware comments and token scope", () => {
  it.each(["src/a.css", "src/a.html"])("does not hide tokens or tells after // in %s", path => {
    expect(rules([{ path, content: '// marker\n' + (path.endsWith("css") ? 'a { color: #abc; }' : '<div style="color: #abc">Welcome to your dashboard</div>') }])).toContain("raw-color");
    expect(rules([{ path, content: '// marker a { color: #abc; }' }])).toContain("raw-color");
    expect(detectAiTells([{ path, content: '// marker <h1>Welcome to your dashboard</h1>' }]).map(f => f.rule)).toContain("generic-copy");
  });
  it.each(["src/a.ts", "src/a.js", "src/a.tsx", "ios/a.swift", "android/a.kt"])("strips real script comments in %s", path => {
    expect(lintTokens([{ path, content: '// color: #abc; padding: 13px; Welcome to your dashboard' }], tokens)).toEqual([]);
    expect(detectAiTells([{ path, content: '// Welcome to your dashboard' }])).toEqual([]);
  });
  it("respects script contexts inside HTML and Svelte, including strings", () => {
    const content = '<script>\n// color: #abc; Welcome to your dashboard\nconst url = "http://localhost/path";\n</script>\n<style>a { color: #abc; }</style>\n<p>// Welcome to your dashboard</p>';
    expect(lintTokens([{ path: "a.svelte", content }], tokens).filter(f => f.rule === "raw-color")).toHaveLength(1);
    expect(detectAiTells([{ path: "a.svelte", content }]).filter(f => f.rule === "generic-copy")).toHaveLength(1);
  });
  it("exempts border strokes, max-width and media queries without hiding padding", () => {
    expect(rules([{ path: "a.css", content: 'a { border: 1px solid var(--line); max-width: 1180px; } @media (min-width: 750px) { a { padding: 13px; } }' }])).toEqual(["off-scale-spacing"]);
  });
  it("requires a color context for hex-like text", () => {
    expect(rules([{ path: "a.tsx", content: '<a href="#add">Job #4521</a><div id="abc">#abc</div>' }])).toEqual([]);
    expect(rules([{ path: "a.css", content: '#abc { color: #abc; }' }])).toEqual(["raw-color"]);
  });
  it("does not treat a domain object's size as typography", () => {
    expect(rules([{ path: "a.tsx", content: 'const job = { size: 20 }; const options = { size: 20 };' }])).toEqual([]);
  });
  it("scopes token findings to changed lines", () => {
    const source = { path: "a.css", content: 'a { color: #abc; }\nb { padding: 13px; }' };
    expect(lintTokens([source], tokens, { changedLines: { "a.css": [{ start: 2, end: 2 }] } }).map(f => f.rule)).toEqual(["off-scale-spacing"]);
  });
});

describe("review: cheap tells and deterministic ordering", () => {
  it.each(["#6366f1", "#4f46e5", "rgb(139, 92, 246)", "oklch(0.6 0.2 290)"])("detects gradient color %s", color => {
    expect(detectAiTells([{ path: "a.css", content: `a { background: linear-gradient(${color}, blue); }` }]).map(f => f.rule)).toContain("purple-gradient");
  });
  it("detects JSX emoji icons", () => {
    expect(detectAiTells([{ path: "a.tsx", content: '<button>{"🚀"}</button>' }]).map(f => f.rule)).toContain("emoji-icon");
  });
  it("keeps informative job metadata", () => {
    expect(detectAiTells([{ path: "a.html", content: '<p>Remote · Full-time · Senior</p><p>Remote · Contract · Senior</p>' }])).toEqual([]);
  });
  it("sorts without the ambient locale", () => {
    const locale = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => { throw new Error("ambient locale"); });
    try {
      const sort = () => ordered(["z", "A"].map(file => ({ file, line: 1, column: 1, rule: "raw-color", message: "x" })));
      expect(sort).not.toThrow();
      expect(sort().map(f => f.file)).toEqual(["A", "z"]);
    }
    finally { locale.mockRestore(); }
  });
});

describe("review: protected browser expectations", () => {
  const url = "http://localhost:3000/habits";
  const observation = () => ({ kind: "qa-browser", url, pages: [375, 768, 1440].map(width => ({ width, url, accessibilityTree: "button", screenshot: "aW1hZ2U=", axe: { version: "4.10.3", violations: [], incomplete: [] } })) });
  it("rejects the wrong axe pin", () => {
    expect(verifyWebObservation(observation(), { url, axeVersion: "4.11.0" }).ok).toBe(false);
  });
  it("rejects missing axe version", () => {
    const raw = observation();
    expect(verifyWebObservation({ ...raw, pages: raw.pages.map(p => ({ ...p, axe: { violations: [], incomplete: [] } })) }, { url, axeVersion: "4.10.3" }).ok).toBe(false);
  });
  it("compares the final page URL after redirects", () => {
    const raw = observation(); raw.pages[0]!.url = "http://localhost:3000/login";
    expect(verifyWebObservation(raw, { url, axeVersion: "4.10.3" }).ok).toBe(false);
  });
});
