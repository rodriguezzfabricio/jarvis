import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect } from "vitest";
import { shortTmp } from "../../helpers.ts";

// This reference implementation is only a test oracle. Reviewers still receive the unimplemented fixture repo.
export const store = `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const file = process.env.ITEMS_FILE || new URL('../data/items.jsonl', import.meta.url);
export function saveItem(input) {
  const name = input.trim();
  if (!name || /[\\r\\n]/.test(name)) throw new Error('item name must not be blank');
  appendFileSync(file, JSON.stringify({ name }) + '\\n');
}
export function listItems() {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  if (!text) return [];
  const lines = text.split('\\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map(line => {
    const row = JSON.parse(line);
    if (!row || Array.isArray(row) || typeof row !== 'object' || Object.keys(row).length !== 1 || typeof row.name !== 'string' || !row.name || row.name.trim() !== row.name || /[\\r\\n]/.test(row.name)) throw new Error('invalid item record');
    return row.name;
  });
}
`;
export const cli = `import { saveItem, listItems } from './store.mjs';
function main() {
  const [command, ...parts] = process.argv.slice(2);
  try {
    if (command === 'add') { saveItem(parts.join(' ')); process.stdout.write('saved\\n'); }
    else if (command === 'list' && parts.length === 0) { for (const name of listItems()) process.stdout.write(name + '\\n'); }
    else { console.error('usage: node src/cli.mjs add <name> | list'); process.exitCode = 2; }
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
main();
`;
const fixtures = fileURLToPath(new URL("../../fixtures/plan-review/", import.meta.url));
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

export function check(name: string, source = store, entry = cli, half = "good"): number | null {
  const root = shortTmp("plan-fixture-"); roots.push(root);
  const repo = join(root, "repo"), out = join(root, "out"), tmp = join(root, "tmp");
  cpSync(join(fixtures, half, "repo"), repo, { recursive: true });
  for (const dir of [out, tmp, join(repo, "data")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(repo, "src/store.mjs"), source);
  writeFileSync(join(repo, "src/cli.mjs"), entry);
  const personal = join(repo, "data/items.jsonl"), sentinel = '{"name":"keep this personal item"}\n';
  writeFileSync(personal, sentinel);
  const checks = join(fixtures, half, "checks");
  const definition = JSON.parse(readFileSync(join(checks, `${name}.check.json`), "utf8")) as {
    cases: { id: string; command: string }[]; verify: string;
  };
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, TMPDIR: tmp,
    JARVIS_OUT: out, JARVIS_CHECKS: checks, JARVIS_COMPLETION_FILE: join(root, "complete") };
  writeFileSync(env.JARVIS_COMPLETION_FILE, "test-completion");
  for (const c of definition.cases) {
    const dir = join(out, c.id); mkdirSync(dir);
    const result = spawnSync("/bin/sh", ["-c", c.command], { cwd: repo, env, encoding: "utf8", timeout: 10_000 });
    expect(result.error).toBeUndefined(); expect(result.signal).toBeNull();
    writeFileSync(join(dir, "code"), String(result.status));
    writeFileSync(join(dir, "stdout"), result.stdout);
    writeFileSync(join(dir, "stderr"), result.stderr);
  }
  expect(readFileSync(personal, "utf8")).toBe(sentinel);
  return spawnSync("/bin/sh", ["-c", definition.verify], { cwd: repo, env, timeout: 10_000 }).status;
}

