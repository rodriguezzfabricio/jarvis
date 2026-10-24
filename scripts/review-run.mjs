#!/usr/bin/env node
// Host-only review orchestration. This never grants stage approval.
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters, parseArgs } from 'node:util';
import { pinnedCodexBin } from '../packages/cli/src/config/pins.ts';
import { safeGit } from '../packages/cli/src/eval/git.ts';
import { inspectReviews } from './review-status.mjs';
import { STAGES } from './mutation-stage.mjs';

const PATH = '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin';
const CHECKS = ['install', 'typecheck', 'unit-tests', 'live-probe', 'doctor-live', 'mutation-check'];
export function codexEnvironment(home) {
  return { HOME: join(home, '.jarvis/codex-home/home'), USER: userInfo().username, PATH, CODEX_HOME: join(home, '.jarvis/codex-home') };
}
export function reserveLaneManifest(roundDir, lanes) {
  writeFileSync(join(roundDir, 'lanes'), `lanes ${lanes.join(',')}\n`, { flag: 'wx', mode: 0o600 });
}
/**
 * The evidence commands. The mutation check confirms every mutation on the full suite, or with
 * confirmStage only that stage's (decision 94: a stage review confirms its own stage's mutations).
 */
export function defaultEvidence({ confirmStage } = {}) {
  if (confirmStage !== undefined && !STAGES.includes(confirmStage)) throw Error(`confirm stage must be one of ${STAGES.join(', ')}`);
  return [
    { name: 'install', bin: '/opt/homebrew/bin/pnpm', args: ['-s', 'install', '--frozen-lockfile'] },
    { name: 'typecheck', bin: '/opt/homebrew/bin/pnpm', args: ['-s', 'typecheck'] },
    { name: 'unit-tests', bin: '/opt/homebrew/bin/pnpm', args: ['-s', 'test'] },
    { name: 'live-probe', bin: '/opt/homebrew/bin/pnpm', args: ['-s', 'test:live'] },
    { name: 'doctor-live', bin: process.execPath, args: ['packages/cli/src/cli.ts', 'doctor', '--live'] },
    { name: 'mutation-check', bin: process.execPath, args: confirmStage === undefined ? ['scripts/mutation-check.mjs', '--confirm'] : ['scripts/mutation-check.mjs', '--confirm-stage', confirmStage] },
  ];
}
export const DEFAULT_EVIDENCE = defaultEvidence();
function inside(path, parent) { const r = relative(parent, path); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); }
function exists(path) { try { lstatSync(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
function command(bin, args, cwd, env, stdoutPath, stderrPath = stdoutPath) {
  return new Promise((resolveCode, reject) => {
    let out, err;
    try {
      out = openSync(stdoutPath, 'wx', 0o600);
      err = stderrPath === stdoutPath ? out : openSync(stderrPath, 'wx', 0o600);
      const child = spawn(bin, args, { cwd, env, stdio: ['ignore', out, err] });
      child.once('error', e => { appendFileSync(stderrPath, `${e.message}\n`); resolveCode(127); });
      child.once('close', (code, signal) => resolveCode(code ?? (signal ? 128 : 127)));
    } catch (e) { reject(e); }
    finally { if (out !== undefined) closeSync(out); if (err !== undefined && err !== out) closeSync(err); }
  });
}

export async function runReview(options) {
  // A filtered mutation check is never review evidence (it exits 4); refuse rather than silently drop it.
  // options.env (default: this process's) lets tests state the environment instead of inheriting it.
  if ((options.env ?? process.env).JARVIS_MUTATIONS !== undefined) throw Error('JARVIS_MUTATIONS is set: a filtered mutation check is not review evidence; unset it');
  const defaults = defaultEvidence({ confirmStage: options.confirmStage });
  const home = realpathSync(options.home ?? homedir());
  const repo = realpathSync(options.repo ?? join(home, 'Desktop/jarvis'));
  const round = options.round;
  if (!/^stage\d+-\d+$/.test(round ?? '')) throw Error('round must be stage<N>-<N>');
  const lanes = options.lanes ?? ['A', 'B', 'D'];
  if (!Array.isArray(lanes) || !lanes.length || new Set(lanes).size !== lanes.length || lanes.some(l => !/^[A-D]$/.test(l))) throw Error('lanes must be unique letters A-D');
  const model = options.model ?? 'gpt-6.1-sol';
  const effort = options.effort ?? 'high';
  if (!/^[a-zA-Z0-9_.-]+$/.test(model) || !['low', 'medium', 'high', 'xhigh'].includes(effort)) throw Error('invalid model or effort');
  const codex = options.codex ?? pinnedCodexBin(home);
  if (!isAbsolute(codex)) throw Error('codex must be an absolute path');
  const prompts = realpathSync(options.prompts);
  const schema = realpathSync(options.schema);
  JSON.parse(readFileSync(schema, 'utf8'));
  const texts = Object.fromEntries(lanes.map(l => [l, readFileSync(join(prompts, `prompt-${l}.md`), 'utf8')]));
  const evidence = options.evidence ?? defaults;
  if (!Array.isArray(evidence) || evidence.length !== CHECKS.length || evidence.some((c, i) => c.name !== CHECKS[i] || !isAbsolute(c.bin) || !Array.isArray(c.args) || c.args.some(a => typeof a !== 'string'))) throw Error('evidence must contain the six ordered named commands, absolute binaries and string args');
  const git = (cwd, args) => safeGit(cwd, args, { home }).toString().trim();
  if (git(repo, ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all'])) throw Error('repo has uncommitted changes');
  const revision = git(repo, ['rev-parse', '--verify', 'HEAD']);
  const reviewRoot = join(home, '.jarvis/codex-review');
  const roundDir = join(reviewRoot, round);
  const workspace = join(home, '.jarvis-work/reviews', `${round}-${revision}`);
  // Do not follow pre-existing output directory symlinks into the source repository.
  for (const path of [join(home, '.jarvis'), reviewRoot, roundDir, join(home, '.jarvis-work'), join(home, '.jarvis-work/reviews')]) {
    if (exists(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())) throw Error(`unsafe output directory: ${path}`);
  }
  if (inside(workspace, repo) || inside(roundDir, repo)) throw Error('outputs must be outside repo');
  if (exists(workspace)) throw Error('workspace already exists');
  if (exists(roundDir) && readdirSync(roundDir).some(n => !/^prompt-[A-D]\.md$|^schema\.json$/.test(n))) throw Error('round already contains output; use a new round');
  const plan = { roundDir, workspace, revision, lanes, model, effort, codex };
  if (options.dryRun) return plan;
  mkdirSync(roundDir, { recursive: true, mode: 0o700 });
  // Exclusive manifest creation is also the reservation: concurrent starters cannot both win.
  reserveLaneManifest(roundDir, lanes);
  writeFileSync(join(roundDir, 'status'), '', { flag: 'wx', mode: 0o600 });
  try {
    mkdirSync(join(home, '.jarvis-work/reviews'), { recursive: true, mode: 0o700 });
    // safeGit normally forbids file transports; only this explicit local clone permits one.
    git(home, ['-c', 'protocol.file.allow=always', 'clone', '--no-hardlinks', '--no-checkout', '--', repo, workspace]);
    git(workspace, ['remote', 'remove', 'origin']);
    git(workspace, ['checkout', '--detach', revision]);
    if (git(workspace, ['rev-parse', 'HEAD']) !== revision) throw Error('cloned revision mismatch');
    const responses = join(workspace, 'docs/reviews');
    if (exists(responses)) {
      if (realpathSync(responses) !== responses) throw Error('review responses directory is a symlink');
      for (const name of readdirSync(responses)) if (name.endsWith('-response.md')) unlinkSync(join(responses, name));
    }
    const eDir = join(workspace, '.review-evidence');
    mkdirSync(eDir, { mode: 0o700 });
    writeFileSync(join(eDir, 'README.txt'), `revision ${revision}\n${new Date().toISOString()}\n`);
    const evidenceEnv = { HOME: home, USER: userInfo().username, PATH };
    let failed = false;
    for (const check of evidence) {
      const log = join(eDir, `${check.name}.log`);
      const code = await command(check.bin, check.args, workspace, evidenceEnv, log);
      writeFileSync(log, `${stripVTControlCharacters(readFileSync(log, 'utf8')).replace(/\n?$/, '\n')}exit ${code}\n`);
      failed ||= code !== 0;
    }
    writeFileSync(join(roundDir, 'workspace.txt'), `${workspace}\n`, { flag: 'wx' });
    appendFileSync(join(roundDir, 'status'), 'evidence-done\n');
    const env = codexEnvironment(home);
    await Promise.all(lanes.map(async l => {
      const code = await command(codex, ['exec', '-C', workspace, '-m', model, '--sandbox', 'read-only', '--ephemeral', '--json', '-c', `model_reasoning_effort="${effort}"`, '--output-schema', schema, '-o', join(roundDir, `verdict-${l}.json`), '--', texts[l]], workspace, env, join(roundDir, `events-${l}.jsonl`), join(roundDir, `stderr-${l}.txt`));
      appendFileSync(join(roundDir, 'status'), `lane ${l} exit ${code}\n`);
      failed ||= code !== 0;
    }));
    appendFileSync(join(roundDir, 'status'), 'codex-done\n');
    const report = inspectReviews(reviewRoot).rounds.find(r => r.name === round);
    return { ...plan, exitCode: failed || report?.result !== 'PASS' ? 1 : 0 };
  } catch (error) {
    appendFileSync(join(roundDir, 'status'), 'runner-error\n');
    throw error;
  }
}

/**
 * The CLI's values and runReview options. parseArgs keeps only an option's last value, so every --confirm-stage token is read
 * from the raw tokens: a repeat in either spelling, or any bad value, is refused before anything starts
 * (Codex re-check of decision 94).
 */
export function parseCli(args) {
  const { values, tokens } = parseArgs({ args, tokens: true, options: Object.fromEntries(['round', 'lanes', 'model', 'effort', 'prompts', 'schema', 'repo', 'codex', 'evidence-config', 'confirm-stage'].map(k => [k, { type: 'string' }]).concat([['dry-run', { type: 'boolean' }], ['help', { type: 'boolean' }]])) });
  const stages = tokens.filter(t => t.kind === 'option' && t.name === 'confirm-stage');
  if (stages.length > 1) throw Error('--confirm-stage may be given only once');
  for (const t of stages) if (!STAGES.includes(t.value)) throw Error(`confirm stage must be one of ${STAGES.join(', ')}`);
  const options = { ...values, lanes: values.lanes?.split(','), dryRun: values['dry-run'], confirmStage: stages[0]?.value };
  return { values, options };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values, options } = parseCli(process.argv.slice(2));
    if (values.help) console.log(`Usage: node scripts/review-run.mjs --round stage0-17 --prompts <dir> --schema <file> [--lanes A,B,D] [--model gpt-6.1-sol] [--effort high] [--repo <dir>] [--codex <absolute-path>] [--dry-run] [--evidence-config <trusted-json>] [--confirm-stage <${STAGES.join('|')}>]\nAdvisory only; never grants stage approval. Existing output is never overwritten.`);
    else {
      const result = await runReview({ ...options, evidence: values['evidence-config'] ? JSON.parse(readFileSync(resolve(values['evidence-config']), 'utf8')) : undefined });
      console.log(`${values['dry-run'] ? 'Dry run' : 'Completed'}: ${result.revision}\nWorkspace: ${result.workspace}`);
      for (const lane of result.lanes) console.log(`Lane ${lane} verdict: ${join(result.roundDir, `verdict-${lane}.json`)}`);
      process.exitCode = result.exitCode ?? 0;
    }
  } catch (error) { console.error(`review-run: ${error.message}`); process.exitCode = 1; }
}
