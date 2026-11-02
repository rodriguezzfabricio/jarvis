import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { shortTmp } from "../helpers.ts";

// This reference implementation is only a test oracle. Reviewers still receive the unimplemented fixture repo.
const store = `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
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
const cli = `import { saveItem, listItems } from './store.mjs';
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
const fixtures = fileURLToPath(new URL("../fixtures/plan-review/", import.meta.url));
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function check(name: string, source = store, entry = cli, half = "good"): number | null {
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

it.each(["good", "bad"])("%s checks accept the specified behavior without touching personal data", half => {
  for (const name of ["item-add", "item-blank", "item-list"]) expect(check(name, store, cli, half), name).toBe(0);
});
it("rejects a wrong default store even when the environment override works", () => {
  expect(check("item-add", store.replace("../data/items.jsonl", "../data/wrong.jsonl"))).not.toBe(0);
});
it("rejects dropping unquoted words from an item name", () => {
  expect(check("item-add", store, cli.replace("parts.join(' ')", "parts[0] ?? ''"))).not.toBe(0);
});
it("rejects silently omitting trim", () => {
  expect(check("item-add", store.replace("input.trim()", "input"))).not.toBe(0);
});
it("rejects the wrong blank-name exit code and missing error message", () => {
  expect(check("item-blank", store, cli.replace("console.error(e.message); process.exitCode = 1", "process.exitCode = 2"))).not.toBe(0);
});
it("rejects carriage returns inside a name", () => {
  expect(check("item-blank", store.replace("/[\\r\\n]/", "/[\\n]/"))).not.toBe(0);
});
it("rejects list using the wrong default even when add uses the correct one", () => {
  expect(check("item-list", store.replace("readFileSync(file,", "readFileSync(process.env.ITEMS_FILE || new URL('../data/wrong.jsonl', import.meta.url),"))).not.toBe(0);
});
it("rejects hiding file read failures as an empty list", () => {
  expect(check("item-list", store.replace("if (e.code === 'ENOENT') return []; throw e;", "return [];"))).not.toBe(0);
});
it("rejects accepting extra arguments to list", () => {
  expect(check("item-list", store, cli.replace(" && parts.length === 0", ""))).not.toBe(0);
});
it("rejects treating an existing zero-byte store as a parse error", () => {
  expect(check("item-list", store.replace("if (!text) return [];", "if (!text) throw new Error('empty store');"))).not.toBe(0);
});
it("rejects success for an unknown command", () => {
  expect(check("item-add", store, cli.replace("process.exitCode = 2", "process.exitCode = command === 'unknown' ? 0 : 2"))).not.toBe(0);
});
it("rejects success when the command is missing", () => {
  expect(check("item-add", store, cli.replace("process.exitCode = 2", "process.exitCode = command === undefined ? 0 : 2"))).not.toBe(0);
});
it("rejects announcing saved after a failed write", () => {
  expect(check("item-add", store, cli.replace("console.error(e.message);", "process.stdout.write('saved\\n'); console.error(e.message);"))).not.toBe(0);
});
it("rejects dropping the record shape validation", () => {
  expect(check("item-list", store.replace(/    if \(!row.*throw new Error\('invalid item record'\);/, ""))).not.toBe(0);
});
it("rejects emitting partial output before a later malformed record", () => {
  const streaming = store.replace(/  return lines.map\(line => \{[\s\S]*?  \}\);/, "  return (function* () { for (const line of lines) yield JSON.parse(line).name; })();");
  expect(check("item-list", streaming)).not.toBe(0);
});
it("rejects forbidding a valid interior tab", () => {
  expect(check("item-add", store.replace("if (!name ||", "if (name.includes('\\t') || !name ||"))).not.toBe(0);
});
it("rejects resolving a relative override against the application directory", () => {
  const wrong = store.replace("process.env.ITEMS_FILE ||", "(process.env.ITEMS_FILE ? new URL('../' + process.env.ITEMS_FILE, import.meta.url) : null) ||");
  expect(check("item-add", wrong)).not.toBe(0);
});
it("rejects deleting existing items when a blank add is refused", () => {
  const wrong = store.replace("throw new Error('item name must not be blank');", "{ writeFileSync(file, ''); throw new Error('item name must not be blank'); }");
  expect(check("item-blank", wrong)).not.toBe(0);
});
