import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { runSession, type SessionSpec, type SessionOutcome } from "../proc/session.ts";
import { detectOsvEcosystems, hashOsvDatabase, pathInside, type OsvDatabaseManifest, type OsvEcosystem } from "./osv-database.ts";
import { reportedScannerVersion } from "./offline.ts";

export interface OsvFetchInput { projectDir: string; outputDir: string }
export interface OsvFetchDeps {
  spawn?: (spec: SessionSpec) => Promise<SessionOutcome>;
  now?: () => Date;
  timeoutMs?: number;
}

/** Controlled manifests select database ecosystems without executing or trusting the project's code. */
function seed(dir: string, ecosystems: OsvEcosystem[]): string[] {
  const fixtures = {
    npm: ["package-lock.json", JSON.stringify({ name: "jarvis-offline-db", lockfileVersion: 3, packages: { "": { name: "jarvis-offline-db", version: "1.0.0" }, "node_modules/lodash": { version: "4.17.20", resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz" } } })],
    Go: ["go.sum", "golang.org/x/text v0.3.0 h1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n"],
    PyPI: ["requirements.txt", "requests==2.19.1\n"],
  } as const;
  return ecosystems.flatMap((ecosystem) => {
    const [name, content] = fixtures[ecosystem]; const path = join(dir, name);
    writeFileSync(path, content, { mode: 0o600 });
    return ["--lockfile", path];
  });
}

/** Explicit network operation for the runner, before checks are installed and approved. Never called by a gate. */
export async function fetchOsvDatabase(input: OsvFetchInput, deps: OsvFetchDeps = {}): Promise<OsvDatabaseManifest> {
  const project = realpathSync(input.projectDir); const output = resolve(input.outputDir);
  const ecosystems = detectOsvEcosystems(project);
  if (ecosystems.length === 0) throw Error("No supported OSV ecosystem found");
  if (!isAbsolute(input.outputDir) || pathInside(project, output)) throw Error("OSV database must be outside the project");
  if (existsSync(output)) throw Error("OSV database output already exists; use a new snapshot folder");
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  if (pathInside(project, realpathSync(dirname(output)))) throw Error("OSV database must be outside the project");
  const stage = mkdtempSync(join(dirname(output), ".osv-fetch-"));
  const scratch = mkdtempSync(join(tmpdir(), "jarvis-osv-fetch-"));
  try {
    const home = join(scratch, "home"); const tmp = join(scratch, "tmp"); const repo = join(scratch, "input");
    for (const path of [home, tmp, repo]) mkdirSync(path, { mode: 0o700 });
    const spec: SessionSpec = {
      bin: "/opt/homebrew/bin/osv-scanner", args: ["--version"], cwd: repo,
      env: { PATH: "/usr/bin:/bin", HOME: home, TMPDIR: tmp, LANG: "C", CI: "1", OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: stage },
      timeoutMs: deps.timeoutMs ?? 1_200_000, killGraceMs: 100, maxOutputBytes: 8 * 1024 * 1024,
    };
    const spawn = deps.spawn ?? runSession;
    const version = await spawn({ ...spec, timeoutMs: 10_000 });
    if (version.code !== 0 || version.timedOut || version.overflowed || JSON.stringify(reportedScannerVersion("osv-scanner", version.stdout)) !== '["2.7.0"]') throw Error("OSV scanner version mismatch");
    const result = await spawn({ ...spec, args: ["scan", "source", "--offline", "--offline-vulnerabilities", "--download-offline-databases", "--x-plugins=vulnmatch/osvlocal", "--no-resolve", "--no-call-analysis=go", "--no-call-analysis=rust", "--format=json", ...seed(repo, ecosystems)] });
    if ((result.code !== 0 && result.code !== 1) || result.timedOut || result.overflowed) throw Error("OSV database download failed");
    const files = hashOsvDatabase(stage);
    if (files.length === 0) throw Error("OSV database download produced no files");
    const manifest: OsvDatabaseManifest = { schema: 1, scannerVersion: "2.7.0", fetchedAt: (deps.now ?? (() => new Date()))().toISOString(), ecosystems, files };
    writeFileSync(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    if (existsSync(output)) throw Error("OSV database output already exists");
    renameSync(stage, output);
    return manifest;
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function osvDbFetchMain(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (args.length !== 2) throw Error("Usage: node scripts/osv-db-fetch.mjs <project> <new-database-folder>");
  const manifest = await fetchOsvDatabase({ projectDir: resolve(args[0]!), outputDir: resolve(args[1]!) });
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}
