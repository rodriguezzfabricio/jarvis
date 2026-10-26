import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

// Keep domain vocabulary in the test, never in the plugin it inspects.
const forbidden = [
  /\brecruit(?:er|ers|ing|ment)?\b/i, /\bhiring(?:[-\s]+managers?)?\b/i, /\boutreach\b/i,
  /\bcontact(?:s|ed|ing)?\b/i, /\be[-\s]?mail[-\s]+providers?\b/i, /\bfollow[-\s]?ups?\b/i,
  /\blinked[-\s]?in\b/i, /\bATS\b/i, /\bhabits?\b/i, /\bstreaks?\b/i, /\breminders?\b/i,
  /\bcheck[-\s]?offs?\b/i, /\bjob[-\s]+(?:search|trackers?|applications?)\b/i,
  /\b(?:FreeHire|Gmail|Greenhouse)\b/i,
];

function bannedTerms(text: string): string[] {
  return forbidden.filter((pattern) => pattern.test(text)).map(String);
}

function filesUnder(path: string, parents: readonly string[] = []): string[] {
  const real = realpathSync(path);
  if (parents.includes(real)) throw new Error(`symlink cycle: ${path}`);
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).sort().flatMap((name) => filesUnder(join(path, name), [...parents, real]));
}

function evalFiles(root: string, evalRoot: string): string[] {
  const answers = filesUnder(evalRoot);
  const realAnswers = new Set(answers.map((path) => realpathSync(path)));
  const hashes = new Set(answers.map((path) => digest(path)));
  return filesUnder(root).filter((path) =>
    /(?:^|[/\\])evals?(?:[/\\]|\.)/i.test(relative(root, path)) ||
    realAnswers.has(realpathSync(path)) || hashes.has(digest(path)) ||
    /"(?:expected_output|expectations|skill_name)"\s*:/.test(readFileSync(path, "utf8")),
  );
}

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "stage2-contamination-"));
  temporary.push(root);
  mkdirSync(join(root, "plugin"));
  mkdirSync(join(root, "evals"));
  writeFileSync(join(root, "evals", "answer.json"), '{"expected_output":"a synthetic answer"}');
  return root;
}

describe("the installed plugin exposes instructions, not evaluation answers", () => {
  it("contains no banned domain terms in any reachable file, including templates and agents", () => {
    const problems = filesUnder(join(repo, "plugin")).flatMap((path) =>
      bannedTerms(`${relative(repo, path)}\n${readFileSync(path, "utf8")}`).map((term) => `${relative(repo, path)}: ${term}`),
    );
    expect(problems).toEqual([]);
  });

  it("has no eval file reachable through plugin symlinks or copied into the bundle", () => {
    expect(evalFiles(join(repo, "plugin"), join(repo, "evals", "skills"))).toEqual([]);
  });

  it("the ban-list guard catches case, plurals, template comments and agent prose", () => {
    for (const text of ["RECRUITERS", "hiring managers", "outreach", "contacts", "Email providers", "follow-ups", "LinkedIn", "ATS", "<!-- habits -->", "streaks", "reminders", "check-offs", "job search", "FreeHire"]) {
      expect(bannedTerms(text), text).not.toEqual([]);
    }
    expect(bannedTerms("A library catalogue uses matching categories and a batch export.")).toEqual([]);
  });

  it("follows directory and file symlinks and detects renamed or copied answer files", () => {
    const root = fixture();
    symlinkSync("../evals", join(root, "plugin", "sources"));
    symlinkSync("../evals/answer.json", join(root, "plugin", "notes.md"));
    writeFileSync(join(root, "plugin", "guide.md"), readFileSync(join(root, "evals", "answer.json")));
    expect(evalFiles(join(root, "plugin"), join(root, "evals")).map((path) => relative(root, path))).toEqual([
      "plugin/guide.md", "plugin/notes.md", "plugin/sources/answer.json",
    ]);
    expect(filesUnder(join(repo, "plugin"))).toContain(resolve(repo, "plugin/skills/spec/templates/spec.md"));
    expect(filesUnder(join(repo, "plugin"))).toContain(resolve(repo, "plugin/agents/researcher.md"));
  });

  it("fails closed on broken links and cycles instead of silently skipping files", () => {
    const root = fixture();
    symlinkSync("missing", join(root, "plugin", "broken"));
    expect(() => filesUnder(join(root, "plugin"))).toThrow();
    rmSync(join(root, "plugin", "broken"));
    symlinkSync(".", join(root, "plugin", "cycle"));
    expect(() => filesUnder(join(root, "plugin"))).toThrow("symlink cycle");
  });
});

// SHA-256 values captured before moving the evals; relocation must not change their content.
const originalEvals: Record<string, string> = {
  "research/evals.json": "1db04fe4ae302e1dd0a8ad25e91e41a659941000e2f07df45ca368bbd48f21d3",
  "research/files/recorded-vendor-page.md": "33dd73de9a78d66449b2664f06c68ceb134cf79a55ac88247e3cae970b0ba8e1",
  "design/evals.json": "84546450436c3a5c99c371e7d3599186d567165da7e9612ecc8e43f77a3737e5",
  "security/evals.json": "c3273544e919230245ac29c2657f09ae5d09c078d26fe16996bec9589174982e",
  "spec/evals.json": "6867fa364b3620bc97c78dae2b95dceee8f23a68a3e0b39dcaea8036b3dfad8c",
  "qa/evals.json": "2c153434102fc2471cb2599892d04e6c7b898b9dcb71482d67d24fa1fb39162c",
  "onboard/evals.json": "2770b87ac2df835c57ca002969561f96046709016f0ae42a0f9c61f9b0b58d87",
  "onboard/files/hostile-readme.md": "c7c96edf2d542f56ccca5cbae41492aa8b1ef08e113adab4a6645ab442e05111",
  "intake/evals.json": "dcca8f53313626146cd447230c53e076b15ae7753aee2d5fad0ec89bdb6bf591",
  "architect/evals.json": "81107a0aa5e913f2f6ec073a49dd2e2fb57924b8d8bbf51dc00217e310829cc4",
  "review/evals.json": "7081b1b0fad360962801c17f0c2257e2f56005389546efe94701fe5469659ae3",
  "sweep/evals.json": "d486c5277390c9105c087d941191394da33416eedf4126612de246d2346a80ca",
  "sweep/files/sweep-findings.md": "7237b1392928f8551cd2c6212e0ccc4fc9243a2ad01ff95e6863529ebdb833bc",
  "compound/evals.json": "764664b35170ee6580c623a2ad2f84b813fb4ca4fd5ec747b92e8d12a30901c6",
  "compound/files/run-ledger.md": "51a0f75cf3862e53ce3ba6acd6f4c8360df3020eabe50c415f3f855fc9295377",
  "build/evals.json": "376bd10bfedbe2a05f0da9420999218798e3f16ff70cd6fc99b08ca01ed5b3e5",
  "build/files/hostile-contact-page.html": "82d950aae77b852ab3bcfea6802bf421353597baab2dbed2f83a8c754bc212af",
  "ship/evals.json": "6be1a8c6d8e3c0d07dcfc13c3b55e5c6a35c0083da475ee62426abe409ec702f",
  "debug/evals.json": "82fe88193b7c1e861fbcbfe21c42e6ce13cbe1b5283a38fe632b6c9b99d80abf"
};

it("preserves every original eval and fixture byte outside the plugin", () => {
  const root = join(repo, "evals", "skills");
  const actual = Object.fromEntries(filesUnder(root).map((path) => [relative(root, path), digest(path)]));
  expect(actual).toEqual(originalEvals);
});
