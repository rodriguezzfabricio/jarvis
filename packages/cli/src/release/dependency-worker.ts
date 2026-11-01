// Copied into the runner's scratch folder and started ONLY inside the dependency sandbox. No project imports.
import { spawn } from "node:child_process";
import { lstatSync, opendirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

interface WorkerInput {
  bin: string; version: string; nodeVersion: string; args: string[]; roots: string[];
  maxBytes: number; maxFiles: number;
}
const input = JSON.parse(process.argv[2]!) as WorkerInput;
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };

function measure(final: boolean): number {
  let bytes = 0, files = 0;
  const walk = (path: string, depth: number): number => {
    const st = lstatSync(path, { throwIfNoEntry: false });
    if (!st) return 0;
    if (++files > input.maxFiles || depth > 64) return 74;
    bytes += st.size;
    if (bytes > input.maxBytes) return 73;
    if (st.isSymbolicLink()) {
      try { return input.roots.some(root => inside(root, realpathSync(path))) ? 0 : 75; }
      catch { return final ? 75 : 0; } // A package manager may be creating the target now.
    }
    if (st.isDirectory()) {
      const dir = opendirSync(path);
      try { for (let entry = dir.readSync(); entry; entry = dir.readSync()) { const code = walk(join(path, entry.name), depth + 1); if (code) return code; } }
      finally { dir.closeSync(); }
    } else if (!st.isFile()) return 75;
    return 0;
  };
  for (const root of input.roots) { const code = walk(root, 0); if (code) return code; }
  return 0;
}
function run(args: string[], version = false): Promise<number> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [input.bin, ...args], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let stdout = "", code = 0;
    const fail = (value: number) => { code ||= value; child.kill("SIGKILL"); };
    const timer = setInterval(() => { try { const limit = measure(false); if (limit) fail(limit); } catch { fail(75); } }, 100);
    child.stdout.on("data", (data: Buffer) => {
      if (version) { stdout += data.toString(); if (stdout.length > 4096) fail(72); }
      else process.stdout.write(data);
    });
    child.stderr.pipe(process.stderr);
    child.on("error", () => { code ||= 72; });
    child.on("close", status => {
      clearInterval(timer);
      if (code) return resolve(code);
      if (status !== 0) return resolve(version ? 72 : 76);
      if (version && stdout.trim() !== input.version) return resolve(72);
      try { resolve(measure(true)); } catch { resolve(75); }
    });
  });
}
if (process.versions.node !== input.nodeVersion) process.exit(72);
const verified = await run(["--version", ...input.args.filter(arg => ["--ignore-scripts", "--ignore-pnpmfile", "--config.manage-package-manager-versions=false"].includes(arg))], true);
process.exitCode = verified || await run(input.args);
