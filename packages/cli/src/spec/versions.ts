import { randomBytes } from "node:crypto";
import { closeSync, constants, fsyncSync, fstatSync, linkSync, lstatSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkSpec } from "./parser.ts";
import type { Assumption, Criterion, Problem, Spec, Story } from "./parser.ts";

export interface SpecVersion { version: number; path: string }
export interface FileProblem extends Problem { file: string }
export interface RepositoryCheck {
  ok: boolean;
  versions: SpecVersion[];
  problems: FileProblem[];
}

export class SpecError extends Error {
  readonly problems: FileProblem[];
  constructor(problems: FileProblem[]) {
    super(problems.map((p) => `${p.file}:${p.line}: ${p.message}`).join("\n"));
    this.problems = problems;
  }
}

function issue(file: string, code: string, message: string): FileProblem {
  return { file, line: 1, code, message };
}

interface DirectoryIdentity { path: string; dev: bigint; ino: bigint }

function directoryIdentities(repo: string): DirectoryIdentity[] {
  return [join(repo, "docs"), join(repo, "docs", "spec")].map((path) => {
    try {
      const st = lstatSync(path, { bigint: true });
      if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("Spec directories must be real directories, not symlinks.");
      return { path, dev: st.dev, ino: st.ino };
    } catch (error) {
      throw new SpecError([issue(path, "spec-directory", String(error))]);
    }
  });
}

function directoriesUnchanged(directories: readonly DirectoryIdentity[]): boolean {
  return directories.every((directory) => {
    try {
      const st = lstatSync(directory.path, { bigint: true });
      return st.isDirectory() && !st.isSymbolicLink() && st.dev === directory.dev && st.ino === directory.ino;
    } catch {
      return false;
    }
  });
}

function assertDirectories(directories: readonly DirectoryIdentity[]): void {
  if (!directoriesUnchanged(directories)) throw new SpecError([issue(directories[1]!.path, "spec-directory-changed", "Spec directories changed during version creation.")]);
}

function scan(repo: string): { versions: SpecVersion[]; problems: FileProblem[] } {
  const versions: SpecVersion[] = [];
  const problems: FileProblem[] = [];
  const dir = join(resolve(repo), "docs", "spec");
  for (const path of [join(resolve(repo), "docs"), dir]) {
    try {
      const st = lstatSync(path);
      if (!st.isDirectory() || st.isSymbolicLink()) {
        problems.push(issue(path, "spec-directory", "Spec directories must be real directories, not symlinks."));
        return { versions, problems };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") problems.push(issue(path, "spec-directory", String(error)));
      return { versions, problems };
    }
  }
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!/^v.*\.md$/.test(entry.name)) continue;
      const path = join(dir, entry.name);
      const match = /^v([1-9]\d*)\.md$/.exec(entry.name);
      const version = Number(match?.[1]);
      if (!match || !Number.isSafeInteger(version) || !entry.isFile() || entry.isSymbolicLink()) {
        problems.push(issue(path, "version-file", "Expected a regular vN.md file with a positive safe integer version; symlinks are refused."));
      } else versions.push({ version, path });
    }
  } catch (error) {
    problems.push(issue(dir, "spec-directory", String(error)));
  }
  versions.sort((a, b) => a.version - b.version);
  return { versions, problems };
}

export function listVersions(repo: string): SpecVersion[] {
  const { versions, problems } = scan(repo);
  if (problems.length) throw new SpecError(problems);
  return versions;
}

export function latestVersion(repo: string): SpecVersion | null {
  return listVersions(repo).at(-1) ?? null;
}

function readVersion(version: SpecVersion): string {
  const fd = openSync(version.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error("Spec versions must be regular files.");
    if (st.nlink > 1) throw new Error("Spec versions must have a single link; hard links are refused.");
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/** Checks the whole history: a valid latest file cannot hide an invalid predecessor. */
export function checkRepository(repo: string): RepositoryCheck {
  const { versions, problems } = scan(repo);
  if (!versions.length && !problems.length) problems.push(issue(join(resolve(repo), "docs", "spec"), "no-versions", "No spec versions found; expected docs/spec/v1.md."));
  let previous = 0;
  for (const version of versions) {
    if (version.version !== previous + 1) problems.push(issue(version.path, "version-gap", `Missing v${previous + 1}.md before v${version.version}.md.`));
    previous = version.version;
    try {
      const result = checkSpec(readVersion(version), version.path);
      problems.push(...result.problems.map((p) => ({ ...p, file: version.path })));
    } catch (error) {
      problems.push(issue(version.path, "spec-read", String(error)));
    }
  }
  return { ok: problems.length === 0, versions, problems };
}

export interface CreateOptions {
  /** UTC date, defaulting to today. */
  date?: string;
  /** Receives the next-version draft; never receives a writable older file. */
  revise?: (draft: string) => string;
}

/** Publishes a complete file exclusively. A competing writer wins without losing its bytes. */
export function createNextVersion(repo: string, opts: CreateOptions = {}): SpecVersion {
  const repoRoot = resolve(repo);
  const directories = directoryIdentities(repoRoot);
  const result = checkRepository(repoRoot);
  if (!result.ok) throw new SpecError(result.problems);
  const latest = result.versions.at(-1)!;
  const next: SpecVersion = { version: latest.version + 1, path: join(repoRoot, "docs", "spec", `v${latest.version + 1}.md`) };
  if (!Number.isSafeInteger(next.version)) throw new SpecError([issue(latest.path, "version", "The next version exceeds the safe integer range.")]);
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const source = readVersion(latest).replaceAll("\r\n", "\n");
  const previous = checkSpec(source, latest.path);
  if (!previous.ok) throw new SpecError(previous.problems.map((p) => ({ ...p, file: latest.path })));
  let draft = source
    .replace(/^spec: .*$/m, `spec: ${next.version}`)
    .replace(/^date: .*$/m, `date: ${date}`)
    .replace(/^status: .*$/m, "status: draft")
    .replace(/^supersedes: .*$/m, `supersedes: ${latest.version}`);
  if (previous.spec.headingLine !== null) {
    const lines = draft.split("\n");
    lines[previous.spec.headingLine - 1] = `# Spec v${next.version}`;
    draft = lines.join("\n");
  }
  if (opts.revise) draft = opts.revise(draft);
  const checked = checkSpec(draft, next.path);
  if (!checked.ok) throw new SpecError(checked.problems.map((p) => ({ ...p, file: next.path })));
  const tmp = join(repoRoot, "docs", "spec", `.v${next.version}-${randomBytes(12).toString("hex")}.tmp`);
  assertDirectories(directories); // before opening draft
  const fd = openSync(tmp, "wx", 0o600);
  try {
    assertDirectories(directories); // before write
    writeFileSync(fd, draft);
    assertDirectories(directories); // after write
    fsyncSync(fd);
    linkSync(tmp, next.path);
    assertDirectories(directories); // after publication
  } finally {
    closeSync(fd);
    // A replaced path may now name someone else's file; leave detached temporary files alone.
    if (directoriesUnchanged(directories)) rmSync(tmp, { force: true });
  }
  const dirFd = openSync(join(repoRoot, "docs", "spec"), "r");
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  return next;
}

export interface IdChanges { added: string[]; removed: string[]; changed: string[] }
export interface SpecDiff {
  from: number;
  to: number;
  stories: IdChanges;
  criteria: IdChanges;
  assumptions: IdChanges;
  /** Includes both ends when a criterion moves to another story. */
  affectedStoryIds: string[];
}

type Entity = Story | Criterion | Assumption;
const sorted = (ids: Iterable<string>): string[] => [...ids].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));

function content(entry: Entity): string {
  const extra = "priority" in entry ? entry.priority : "storyId" in entry ? entry.storyId : entry.kind;
  return JSON.stringify([entry.text, entry.details, extra]);
}

function compare(before: Entity[], after: Entity[]): IdChanges {
  const a = new Map(before.map((entry) => [entry.id, entry]));
  const b = new Map(after.map((entry) => [entry.id, entry]));
  return {
    added: sorted(b.keys()).filter((id) => !a.has(id)),
    removed: sorted(a.keys()).filter((id) => !b.has(id)),
    changed: sorted(a.keys()).filter((id) => b.has(id) && content(a.get(id)!) !== content(b.get(id)!)),
  };
}

export function diffVersions(repo: string, from: number, to: number): SpecDiff {
  const result = checkRepository(repo);
  if (!result.ok) throw new SpecError(result.problems);
  const load = (number: number): Spec => {
    const version = Number.isSafeInteger(number) && number > 0 ? result.versions.find((v) => v.version === number) : undefined;
    if (!version) throw new SpecError([issue(join(resolve(repo), "docs", "spec"), "missing-version", `Spec version ${number} does not exist.`)]);
    const checked = checkSpec(readVersion(version), version.path);
    if (!checked.ok) throw new SpecError(checked.problems.map((p) => ({ ...p, file: version.path })));
    return checked.spec;
  };
  const before = load(from);
  const after = load(to);
  const stories = compare(before.stories, after.stories);
  const criteria = compare(before.criteria, after.criteria);
  const assumptions = compare(before.assumptions, after.assumptions);
  const affected = new Set([...stories.added, ...stories.removed, ...stories.changed]);
  const changedCriteria = new Set([...criteria.added, ...criteria.removed, ...criteria.changed]);
  for (const entry of [...before.criteria, ...after.criteria]) if (changedCriteria.has(entry.id)) affected.add(entry.storyId);
  return { from, to, stories, criteria, assumptions, affectedStoryIds: sorted(affected) };
}
