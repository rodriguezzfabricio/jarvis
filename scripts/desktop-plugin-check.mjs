#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { compatibilityCommand, compatibilityPrompt, inspectCompatibility, captureCompatibility, desktopTranscriptDirectory } from '../packages/cli/src/harness/claude/desktop-evidence.ts';
import { writeTaskSettings } from '../packages/cli/src/harness/claude/settings.ts';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error(`not a bounded regular evidence file: ${path}`);
  return readFileSync(path, 'utf8');
};
const json = path => JSON.parse(read(path));
const save = (path, value) => writeFileSync(path, value, { flag: 'wx', mode: 0o600 });
const hashes = pluginDir => Object.fromEntries(['hooks/session-start.mjs', 'hooks/tripwire.mjs', 'hooks/hooks.json', '.claude-plugin/plugin.json'].map(name => [name, createHash('sha256').update(read(join(pluginDir, name))).digest('hex')]));
export function prepareCheck({ home = homedir(), pluginDir = join(repo, 'plugin'), runId = randomUUID() } = {}) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,79}$/.test(runId)) throw new Error('invalid run id');
  home = realpathSync(home); pluginDir = realpathSync(pluginDir);
  const pluginHashes = hashes(pluginDir);
  const directory = join(home, '.jarvis/desktop-check', runId);
  const workspace = join(home, '.jarvis-work/desktop-check', runId);
  const cacheDir = join(home, '.jarvis-work/desktop-check-cache', runId);
  if ([directory, workspace, cacheDir].some(existsSync)) throw new Error('run already exists; choose a new id');
  for (const path of [directory, workspace, cacheDir]) {
    for (let parent = dirname(path); parent !== dirname(parent); parent = dirname(parent)) {
      if (existsSync(parent) && realpathSync(parent) !== parent) throw new Error('run ancestors must not use symlinks');
    }
  }
  for (const path of [directory, workspace, cacheDir]) { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); mkdirSync(path, { mode: 0o700 }); if (realpathSync(path) !== path) throw new Error('run folders must not use symlinks'); }
  const run = { schema: 1, runId, directory, workspace, cacheDir, jarvisHome: join(home, '.jarvis'), pluginDir, pluginHashes, notBefore: new Date().toISOString(), probeCommand: compatibilityCommand };
  writeTaskSettings(join(directory, 'settings.json'), { worktree: workspace, jarvisHome: run.jarvisHome, cacheDir, allowedDomains: [] });
  save(join(workspace, 'PROMPT.txt'), compatibilityPrompt + '\n');
  save(join(directory, 'run.json'), JSON.stringify(run, null, 2));
  return run;
}
export function loadCheck(directory, home = homedir()) {
  home = realpathSync(home); directory = realpathSync(directory);
  const run = json(join(directory, 'run.json'));
  if (run.schema !== 1 || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,79}$/.test(run.runId) || directory !== join(home, '.jarvis/desktop-check', run.runId) || run.directory !== directory || run.workspace !== join(home, '.jarvis-work/desktop-check', run.runId) || run.cacheDir !== join(home, '.jarvis-work/desktop-check-cache', run.runId) || run.jarvisHome !== join(home, '.jarvis') || run.probeCommand !== compatibilityCommand || !Number.isFinite(Date.parse(run.notBefore))) throw new Error('invalid run manifest');
  for (const path of [run.workspace, run.cacheDir, run.pluginDir]) if (realpathSync(path) !== path) throw new Error('run paths changed');
  if (JSON.stringify(hashes(run.pluginDir)) !== JSON.stringify(run.pluginHashes)) throw new Error('plugin changed since preparation; prepare a new run');
  return run;
}
export function verifyCheck(directory, transcript, home = homedir()) {
  const run = loadCheck(directory, home);
  const result = { pass: false, advisory: true, scope: 'plugin compatibility only; no stage approval', problems: [], cli: null, desktop: null };
  try {
    const probe = json(join(directory, 'probe.json')); const outcome = json(join(directory, 'outcome.json'));
    if (probe.ok !== true || outcome.code !== 0 || outcome.timedOut !== false || outcome.overflowed !== false) throw new Error('canary or CLI process failed');
    result.cli = inspectCompatibility(read(join(directory, 'stream.jsonl')), run, 'cli');
    if (!result.cli.pass) result.problems.push(...result.cli.problems.map(p => `CLI: ${p}`));
  } catch (e) { result.problems.push(`CLI: ${e.message}`); }
  try {
    if (!transcript) throw new Error(`supply a transcript from ${desktopTranscriptDirectory(realpathSync(home), run.workspace)}`);
    const path = resolve(transcript);
    if (dirname(path) !== desktopTranscriptDirectory(realpathSync(home), run.workspace) || realpathSync(path) !== path || !basename(path).endsWith('.jsonl')) throw new Error('transcript must be the framework file for this workspace');
    result.desktop = inspectCompatibility(read(path), run, 'desktop');
    if (!result.desktop.pass) result.problems.push(...result.desktop.problems.map(p => `desktop: ${p}`));
  } catch (e) { result.problems.push(`desktop: ${e.message}`); }
  result.pass = result.cli?.pass === true && result.desktop?.pass === true && result.problems.length === 0;
  return result;
}
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { run: { type: 'string' }, transcript: { type: 'string' } } });
  const command = positionals[0];
  if (command === 'prepare') {
    const run = prepareCheck();
    console.log(`Run: ${run.directory}\n1. Open this folder in a new desktop Code chat with the local Jarvis plugin enabled: ${run.workspace}\n2. Paste the contents of ${join(run.workspace, 'PROMPT.txt')}\nCLI comparison: node scripts/desktop-plugin-check.mjs cli --run ${run.directory}`);
  } else if (command === 'cli' && values.run) {
    const run = loadCheck(values.run); await captureCompatibility(run); console.log(`CLI evidence: ${run.directory}/stream.jsonl`);
  } else if (command === 'verify' && values.run) {
    const result = verifyCheck(values.run, values.transcript); console.log(JSON.stringify(result, null, 2)); process.exitCode = result.pass ? 0 : 1;
  } else throw new Error('usage: desktop-plugin-check.mjs prepare | cli --run DIR | verify --run DIR --transcript FILE');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
