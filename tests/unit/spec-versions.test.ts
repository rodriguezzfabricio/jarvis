import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { checkRepository, createNextVersion, diffVersions, latestVersion, listVersions, SpecError } from "../../packages/cli/src/spec/versions.ts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, linkSync: vi.fn(actual.linkSync), openSync: vi.fn(actual.openSync), writeFileSync: vi.fn(actual.writeFileSync) };
});
const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
const source = fs.readFileSync(new URL("../fixtures/spec/v1.md", import.meta.url), "utf8");
const root = fs.mkdtempSync(join(tmpdir(), "jarvis-spec-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  vi.mocked(fs.linkSync).mockReset().mockImplementation(realFs.linkSync);
  vi.mocked(fs.openSync).mockReset().mockImplementation(realFs.openSync);
  vi.mocked(fs.writeFileSync).mockReset().mockImplementation(realFs.writeFileSync);
});
let n = 0;
function fresh(): { repo: string; dir: string } {
  const repo = join(root, `repo${++n}`);
  const dir = join(repo, "docs", "spec");
  fs.mkdirSync(dir, { recursive: true });
  return { repo, dir };
}
function version(number: number): string {
  return source.replace("spec: 1", `spec: ${number}`).replace("# Spec v1", `# Spec v${number}`).replace("supersedes: none", `supersedes: ${number === 1 ? "none" : number - 1}`);
}

describe("spec versions (decisions 9, 40)", () => {
  it("lists numerically and finds the latest, ignoring unrelated files", () => {
    const { repo, dir } = fresh();
    for (const v of [10, 2, 1]) fs.writeFileSync(join(dir, `v${v}.md`), version(v));
    fs.writeFileSync(join(dir, "README.md"), "Notes");
    expect(listVersions(repo).map((v) => v.version)).toEqual([1, 2, 10]);
    expect(latestVersion(repo)).toEqual({ version: 10, path: join(dir, "v10.md") });
  });

  it("returns no latest for missing specs and reports a line-numbered check failure", () => {
    const repo = join(root, `missing${++n}`);
    expect(listVersions(repo)).toEqual([]);
    expect(latestVersion(repo)).toBeNull();
    expect(checkRepository(repo)).toMatchObject({ ok: false, problems: [expect.objectContaining({ line: 1, code: "no-versions" })] });
    expect(() => createNextVersion(repo)).toThrow(SpecError);
  });

  it("checks every version, including older malformed versions", () => {
    const { repo, dir } = fresh();
    fs.writeFileSync(join(dir, "v1.md"), source.replace("status: unconfirmed", "status: invalid"));
    fs.writeFileSync(join(dir, "v2.md"), version(2));
    const result = checkRepository(repo);
    expect(result.ok).toBe(false);
    expect(result.problems).toContainEqual(expect.objectContaining({ file: join(dir, "v1.md"), line: 4, code: "status" }));
    expect(() => createNextVersion(repo)).toThrow(SpecError);
    expect(fs.existsSync(join(dir, "v3.md"))).toBe(false);
  });

  it("reports gaps from v1 onwards without allocating the missing range", () => {
    const { repo, dir } = fresh();
    fs.writeFileSync(join(dir, "v2.md"), version(2));
    fs.writeFileSync(join(dir, "v1000000000.md"), version(1000000000));
    const gaps = checkRepository(repo).problems.filter((p) => p.code === "version-gap");
    expect(gaps).toHaveLength(2);
    expect(gaps[0]).toMatchObject({ file: join(dir, "v2.md"), line: 1, message: expect.stringContaining("v1.md") });
    expect(gaps[1]?.message).toContain("v3.md");
    expect(() => createNextVersion(repo)).toThrow(SpecError);
  });

  it.each(["v0.md", "v01.md", "v9007199254740992.md", "vnext.md"])("rejects malformed version file %s", (name) => {
    const { repo, dir } = fresh();
    fs.writeFileSync(join(dir, name), source);
    expect(checkRepository(repo).problems).toContainEqual(expect.objectContaining({ file: join(dir, name), line: 1, code: "version-file" }));
    expect(() => listVersions(repo)).toThrow(SpecError);
  });

  it("reports a header/file name mismatch and bad supersedes", () => {
    const { repo, dir } = fresh();
    fs.writeFileSync(join(dir, "v1.md"), version(2).replace("supersedes: 1", "supersedes: none"));
    expect(checkRepository(repo).problems.map((p) => p.code)).toEqual(expect.arrayContaining(["filename-version", "supersedes"]));
  });

  it("creates the next version from the previous one without changing any older bytes", () => {
    const { repo, dir } = fresh();
    const original = source.replace("status: unconfirmed", "status: confirmed");
    fs.writeFileSync(join(dir, "v1.md"), original);
    const v2 = createNextVersion(repo, { date: "2026-10-25", revise: (draft) => draft.replace("No paid services.", "No paid services or trials.") });
    expect(v2).toEqual({ version: 2, path: join(dir, "v2.md") });
    const second = fs.readFileSync(v2.path, "utf8");
    expect(second).toContain("spec: 2\ndate: 2026-10-25\nstatus: draft\nsupersedes: 1");
    expect(second).toContain("# Spec v2");
    expect(second).toContain("No paid services or trials.");
    createNextVersion(repo, { date: "2026-10-26" });
    expect(fs.readFileSync(join(dir, "v1.md"), "utf8")).toBe(original);
    expect(fs.readFileSync(v2.path, "utf8")).toBe(second);
    expect(checkRepository(repo).ok).toBe(true);
  });

  it("also copies a spec without the optional H1 and with CRLF", () => {
    const { repo, dir } = fresh();
    fs.writeFileSync(join(dir, "v1.md"), source.replace("# Spec v1\n", "").replaceAll("\n", "\r\n"));
    createNextVersion(repo);
    expect(checkRepository(repo).ok).toBe(true);
  });

  it("does not rewrite a fenced title example when there is no actual H1", () => {
    const { repo, dir } = fresh();
    fs.writeFileSync(join(dir, "v1.md"), source.replace("# Spec v1", "```md\n# Spec v1\n```"));
    const next = createNextVersion(repo);
    expect(fs.readFileSync(next.path, "utf8")).toContain("```md\n# Spec v1\n```");
    expect(checkRepository(repo).ok).toBe(true);
  });

  it("rejects an invalid revision or date before creating any file", () => {
    const { repo, dir } = fresh();
    fs.writeFileSync(join(dir, "v1.md"), source);
    expect(() => createNextVersion(repo, { revise: (draft) => draft.replace("[fixed]", "[wrong]") })).toThrow(SpecError);
    expect(() => createNextVersion(repo, { date: "2026-02-30" })).toThrow(SpecError);
    expect(() => createNextVersion(repo, { revise: () => { throw new Error("revision failed"); } })).toThrow("revision failed");
    expect(fs.readdirSync(dir)).toEqual(["v1.md"]);
    expect(fs.readFileSync(join(dir, "v1.md"), "utf8")).toBe(source);
  });

  it("cleans up a torn temporary write and leaves older versions intact", () => {
    const { repo, dir } = fresh();
    fs.writeFileSync(join(dir, "v1.md"), source);
    vi.mocked(fs.writeFileSync).mockImplementationOnce((path) => {
      realFs.writeFileSync(path, "torn draft");
      throw new Error("injected disk failure");
    });
    expect(() => createNextVersion(repo)).toThrow("injected disk failure");
    expect(fs.readdirSync(dir)).toEqual(["v1.md"]);
    expect(fs.readFileSync(join(dir, "v1.md"), "utf8")).toBe(source);
  });

  it("never overwrites a version published by a competing writer", () => {
    const { repo, dir } = fresh();
    fs.writeFileSync(join(dir, "v1.md"), source);
    const competitor = version(2).replace("No paid services.", "Written by competitor.");
    vi.mocked(fs.linkSync).mockImplementationOnce((oldPath, newPath) => {
      realFs.writeFileSync(newPath, competitor);
      realFs.linkSync(oldPath, newPath);
    });
    expect(() => createNextVersion(repo)).toThrow();
    expect(fs.readFileSync(join(dir, "v2.md"), "utf8")).toBe(competitor);
    expect(fs.readFileSync(join(dir, "v1.md"), "utf8")).toBe(source);
    expect(fs.readdirSync(dir).sort()).toEqual(["v1.md", "v2.md"]);
  });

  it.each(["docs", "spec", "file"])("refuses a symlink at %s rather than reading or writing through it", (kind) => {
    const { repo, dir } = fresh();
    const external = join(root, `external${++n}`);
    fs.mkdirSync(external);
    if (kind === "file") {
      fs.writeFileSync(join(external, "v1.md"), source);
      fs.symlinkSync(join(external, "v1.md"), join(dir, "v1.md"));
    } else {
      const externalSpecs = kind === "docs" ? join(external, "spec") : external;
      fs.mkdirSync(externalSpecs, { recursive: true });
      fs.writeFileSync(join(externalSpecs, "v1.md"), source);
      const path = kind === "docs" ? join(repo, "docs") : dir;
      fs.rmSync(path, { recursive: true });
      fs.symlinkSync(external, path);
    }
    expect(checkRepository(repo).ok).toBe(false);
    expect(() => createNextVersion(repo)).toThrow(SpecError);
    expect(fs.readdirSync(external)).toEqual(kind === "docs" ? ["spec"] : ["v1.md"]);
  });

  it("reports non-files and filesystem errors with a file and line", () => {
    const { repo, dir } = fresh();
    fs.mkdirSync(join(dir, "v1.md"));
    expect(checkRepository(repo).problems).toContainEqual(expect.objectContaining({ line: 1, code: "version-file" }));
    const repo2 = join(root, `repo${++n}`);
    fs.mkdirSync(repo2);
    fs.writeFileSync(join(repo2, "docs"), "not a directory");
    expect(checkRepository(repo2).problems).toContainEqual(expect.objectContaining({ line: 1, code: "spec-directory" }));
  });

  it("diffs additions, removals and content changes by ID, including dependent stories", () => {
    const { repo, dir } = fresh();
    fs.writeFileSync(join(dir, "v1.md"), source);
    createNextVersion(repo, { revise: (draft) => draft
      .replace("can record a habit", "can save a habit")
      .replace("- **S3 (P3):** As a user, I can rename a habit.", "- **S4 (P3):** As a user, I can export habits.")
      .replace("**AC1 (S1):**", "**AC1 (S2):**")
      .replace("- **AC3 (S3):** WHEN I rename a habit THE SYSTEM SHALL display its new name.", "- **AC3 (S1):** WHEN I save THE SYSTEM SHALL persist.\n- **AC4 (S4):** WHEN I export THE SYSTEM SHALL write a file.")
      .replace("**A1 [fixed]:**", "**A1 [delegated]:**")
      .replace("- **A2 [delegated]:** Use a local file for storage.", "- **A3 [fixed]:** Keep data locally.") });
    expect(diffVersions(repo, 1, 2)).toEqual({
      from: 1, to: 2,
      stories: { added: ["S4"], removed: ["S3"], changed: ["S1"] },
      criteria: { added: ["AC4"], removed: [], changed: ["AC1", "AC3"] },
      assumptions: { added: ["A3"], removed: ["A2"], changed: ["A1"] },
      affectedStoryIds: ["S1", "S2", "S3", "S4"],
    });
    expect(diffVersions(repo, 2, 1).stories).toEqual({ added: ["S3"], removed: ["S4"], changed: ["S1"] });
  });

  it("ignores locations, version metadata and entity order in an ID diff", () => {
    const { repo, dir } = fresh();
    fs.writeFileSync(join(dir, "v1.md"), source);
    createNextVersion(repo, { revise: (draft) => draft.replace("- **A1 [fixed]:** No paid services.\n- **A2 [delegated]:** Use a local file for storage.", "- **A2 [delegated]:** Use a local file for storage.\n\n- **A1 [fixed]:** No paid services.") });
    const empty = { added: [], removed: [], changed: [] };
    expect(diffVersions(repo, 1, 2)).toMatchObject({ stories: empty, criteria: empty, assumptions: empty, affectedStoryIds: [] });
  });

  it("includes attached prose in an entity diff", () => {
    const { repo, dir } = fresh();
    fs.writeFileSync(join(dir, "v1.md"), source);
    createNextVersion(repo, { revise: (draft) => draft.replace("No paid services.", "No paid services.\nNo trials with a card either.") });
    expect(diffVersions(repo, 1, 2).assumptions.changed).toEqual(["A1"]);
  });

  it("includes attached fenced examples in an entity diff without parsing example IDs", () => {
    const { repo, dir } = fresh();
    fs.writeFileSync(join(dir, "v1.md"), source);
    createNextVersion(repo, { revise: (draft) => draft.replace("No paid services.", "No paid services.\n```md\n- **A99 [fixed]:** Example only.\n```") });
    expect(checkRepository(repo).ok).toBe(true);
    expect(diffVersions(repo, 1, 2).assumptions).toEqual({ added: [], removed: [], changed: ["A1"] });
  });

  it("refuses diffs with malformed, missing or unsafe version numbers", () => {
    const { repo, dir } = fresh();
    fs.writeFileSync(join(dir, "v1.md"), source);
    expect(() => diffVersions(repo, 1, 2)).toThrow(SpecError);
    expect(() => diffVersions(repo, -1, 1)).toThrow(SpecError);
    fs.writeFileSync(join(dir, "v1.md"), source.replace("**A1 [fixed]:**", "**A1:**"));
    expect(() => diffVersions(repo, 1, 1)).toThrow(SpecError);
  });

  it("diffs priority changes and criterion removals, preserving the removed dependency", () => {
    const { repo, dir } = fresh();
    fs.writeFileSync(join(dir, "v1.md"), source);
    createNextVersion(repo, { revise: (draft) => draft.replace("**S1 (P1):**", "**S1 (P2):**")
      .replace("- **AC2 (S2):** WHEN I open the list THE SYSTEM SHALL show my habits.", "- **AC4 (S2):** WHEN I open the list THE SYSTEM SHALL show my habits.") });
    const diff = diffVersions(repo, 1, 2);
    expect(diff.stories.changed).toEqual(["S1"]);
    expect(diff.criteria).toEqual({ added: ["AC4"], removed: ["AC2"], changed: [] });
    expect(diff.affectedStoryIds).toEqual(["S1", "S2"]);
  });
});

describe("spec filesystem review regressions", () => {
  function replaceDirectory(repo: string, kind: "docs" | "spec", mode: "directory" | "symlink") {
    const path = kind === "docs" ? join(repo, "docs") : join(repo, "docs", "spec");
    const moved = join(repo, `original-${kind}`);
    fs.renameSync(path, moved);
    const replacement = mode === "symlink" ? join(root, `replacement${++n}`) : path;
    fs.mkdirSync(replacement, { recursive: true });
    if (mode === "symlink") fs.symlinkSync(replacement, path);
    const specDir = kind === "docs" ? join(replacement, "spec") : replacement;
    fs.mkdirSync(specDir, { recursive: true });
    realFs.writeFileSync(join(specDir, "v1.md"), source);
    return { specDir, movedSpecDir: kind === "docs" ? join(moved, "spec") : moved };
  }
  const replacements = [["docs", "directory"], ["spec", "directory"], ["docs", "symlink"], ["spec", "symlink"]] as const;

  it("refuses multiply-linked spec files for checking, creation and diffing", () => {
    const { repo, dir } = fresh();
    fs.writeFileSync(join(dir, "v1.md"), source);
    realFs.linkSync(join(dir, "v1.md"), join(root, `hardlink${++n}.md`));
    expect(checkRepository(repo).ok).toBe(false);
    expect(checkRepository(repo).problems).toContainEqual(expect.objectContaining({ file: join(dir, "v1.md"), line: 1, message: expect.stringMatching(/hard link|single link/i) }));
    expect(() => createNextVersion(repo)).toThrow(SpecError);
    expect(() => diffVersions(repo, 1, 1)).toThrow(SpecError);
    expect(fs.existsSync(join(dir, "v2.md"))).toBe(false);
    expect(fs.readFileSync(join(dir, "v1.md"), "utf8")).toBe(source);
  });

  it.each(replacements)("refuses a replaced %s (%s) before writing", (kind, mode) => {
    const { repo, dir } = fresh();
    fs.writeFileSync(join(dir, "v1.md"), source);
    let paths: ReturnType<typeof replaceDirectory> | undefined;
    expect(() => createNextVersion(repo, { revise: (draft) => {
      paths = replaceDirectory(repo, kind, mode);
      return draft;
    } })).toThrow(SpecError);
    expect(vi.mocked(fs.writeFileSync).mock.calls.filter(([file]) => typeof file === "number")).toHaveLength(0);
    expect(fs.readdirSync(paths!.specDir)).toEqual(["v1.md"]);
    expect(fs.readFileSync(join(paths!.movedSpecDir, "v1.md"), "utf8")).toBe(source);
  });

  it.each(replacements)("refuses a replaced %s (%s) after writing, before publication", (kind, mode) => {
    const { repo, dir } = fresh();
    fs.writeFileSync(join(dir, "v1.md"), source);
    let paths: ReturnType<typeof replaceDirectory> | undefined;
    let foreignTemp = "";
    vi.mocked(fs.writeFileSync).mockImplementationOnce((file, data, options) => {
      realFs.writeFileSync(file, data, options);
      paths = replaceDirectory(repo, kind, mode);
      const tmp = fs.readdirSync(paths.movedSpecDir).find((name) => name.endsWith(".tmp"))!;
      foreignTemp = join(paths.specDir, tmp);
      realFs.writeFileSync(foreignTemp, "owned by the replacement directory");
    });
    expect(() => createNextVersion(repo)).toThrow(SpecError);
    expect(fs.existsSync(join(paths!.specDir, "v2.md"))).toBe(false);
    expect(fs.readFileSync(foreignTemp, "utf8")).toBe("owned by the replacement directory");
    expect(fs.readFileSync(join(paths!.movedSpecDir, "v1.md"), "utf8")).toBe(source);
  });

  it.each(["docs", "spec"] as const)("refuses a %s replacement while opening the draft, before writing bytes", (kind) => {
    const { repo, dir } = fresh();
    fs.writeFileSync(join(dir, "v1.md"), source);
    vi.mocked(fs.openSync).mockImplementation((path, flags, mode) => {
      const fd = realFs.openSync(path, flags, mode);
      if (flags === "wx") replaceDirectory(repo, kind, "directory");
      return fd;
    });
    expect(() => createNextVersion(repo)).toThrow(SpecError);
    expect(vi.mocked(fs.writeFileSync).mock.calls.filter(([file]) => typeof file === "number")).toHaveLength(0);
    expect(fs.existsSync(join(dir, "v2.md"))).toBe(false);
  });

  it.each(["docs", "spec"] as const)("refuses a %s replacement during publication", (kind) => {
    const { repo, dir } = fresh();
    fs.writeFileSync(join(dir, "v1.md"), source);
    let paths: ReturnType<typeof replaceDirectory> | undefined;
    vi.mocked(fs.linkSync).mockImplementationOnce((oldPath, newPath) => {
      realFs.linkSync(oldPath, newPath);
      paths = replaceDirectory(repo, kind, "directory");
    });
    expect(() => createNextVersion(repo)).toThrow(SpecError);
    expect(fs.existsSync(join(paths!.specDir, "v2.md"))).toBe(false);
    expect(fs.readFileSync(join(paths!.movedSpecDir, "v1.md"), "utf8")).toBe(source);
  });
});
