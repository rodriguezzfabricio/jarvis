import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
// @ts-expect-error standalone script
import { runReview, codexEnvironment, reserveLaneManifest, DEFAULT_EVIDENCE, defaultEvidence, parseCli } from '../../scripts/review-run.mjs';
// @ts-expect-error standalone script
import { inspectReviews } from '../../scripts/review-status.mjs';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'review-run-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
function fixture() {
  const home = join(root, String(++n));
  const repo = join(home, 'repo');
  const prompts = join(home, 'prompts');
  mkdirSync(join(repo, 'docs/reviews'), { recursive: true });
  mkdirSync(prompts);
  writeFileSync(join(repo, 'docs/reviews/old-response.md'), 'builder narrative');
  writeFileSync(join(repo, 'source.txt'), 'committed');
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, env: { PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } });
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'fixture');
  const codex = join(home, 'fake-codex');
  writeFileSync(codex, `#!${process.execPath}\n` + readFileSync(resolve('tests/fixtures/fake-review-codex.mjs'), 'utf8'));
  chmodSync(codex, 0o700);
  for (const lane of ['A', 'B', 'C', 'D']) writeFileSync(join(prompts, `prompt-${lane}.md`), lane);
  const schema = join(home, 'schema.json'); writeFileSync(schema, '{}');
  const evidence = ['install', 'typecheck', 'unit-tests', 'live-probe', 'doctor-live', 'mutation-check'].map(name => ({ name, bin: process.execPath, args: ['-e', `console.log(${JSON.stringify(name === 'mutation-check' ? 'all 7 mutations caught' : '\x1b[31mok\x1b[0m')})`] }));
  return { home, repo, prompts, schema, codex, evidence, round: 'stage0-17', git };
}
it('captures committed evidence, isolated parallel lanes and null stdin, readable by status', async () => {
  const f = fixture();
  process.env.JARVIS_SYNTHETIC_PARENT = 'must-not-inherit';
  try {
    const result = await runReview(f);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(result.roundDir, 'lanes'), 'utf8')).toBe('lanes A,B,D\n');
    expect(existsSync(join(result.workspace, 'docs/reviews/old-response.md'))).toBe(false);
    expect(existsSync(join(f.repo, 'docs/reviews/old-response.md'))).toBe(true);
    expect(f.git('status', '--porcelain').toString()).toBe('');
    expect(execFileSync('/usr/bin/git', ['remote'], { cwd: result.workspace }).toString()).toBe('');
    const lanes = ['A', 'B', 'D'].map(l => JSON.parse(readFileSync(join(result.roundDir, `env-${l}.json`), 'utf8')));
    for (const lane of lanes) {
      expect(Object.keys(codexEnvironment(f.home)).sort()).toEqual(['CODEX_HOME', 'HOME', 'PATH', 'USER']);
      // macOS initializes this runtime key even under /usr/bin/env -i.
      const childKeys = Object.keys(lane.env).filter(k => process.platform !== 'darwin' || k !== '__CF_USER_TEXT_ENCODING');
      expect(childKeys.sort()).toEqual(['CODEX_HOME', 'HOME', 'PATH', 'USER']);
      expect(lane.env).toMatchObject(codexEnvironment(f.home));
      expect(lane.stdinCharacterDevice).toBe(true);
      expect(lane.argv).toContain('read-only');
      expect(lane.argv).toContain('--ephemeral');
      expect(lane.argv.at(-2)).toBe('--');
      expect(lane.argv).toContain('model_reasoning_effort="high"');
    }
    expect(Math.max(...lanes.map(x => x.started)) < Math.min(...lanes.map(x => x.finished))).toBe(true);
    expect(readFileSync(join(result.workspace, '.review-evidence/typecheck.log'), 'utf8')).toBe('ok\nexit 0\n');
    expect(inspectReviews(join(f.home, '.jarvis/codex-review')).rounds[0]).toMatchObject({ result: 'PASS', revision: f.git('rev-parse', 'HEAD').toString().trim() });
    await expect(runReview(f)).rejects.toThrow(/already|exists/);
  } finally { delete process.env.JARVIS_SYNTHETIC_PARENT; }
});
it('records a failed lane and completes all lanes', async () => {
  const f = fixture(); writeFileSync(join(f.prompts, 'prompt-B.md'), 'FAIL');
  const r = await runReview(f);
  expect(r.exitCode).toBe(1);
  expect(readFileSync(join(r.roundDir, 'status'), 'utf8')).toContain('lane B exit 7');
  expect(readFileSync(join(r.roundDir, 'status'), 'utf8')).toMatch(/codex-done\n$/);
});
it('refuses dirty input before creating artifacts', async () => {
  const f = fixture(); writeFileSync(join(f.repo, 'untracked'), 'x');
  await expect(runReview(f)).rejects.toThrow(/uncommitted/);
  expect(existsSync(join(f.home, '.jarvis'))).toBe(false);
});
it('dry run writes nothing and validates lane syntax', async () => {
  const f = fixture();
  const r = await runReview({ ...f, dryRun: true });
  expect(r.lanes).toEqual(['A', 'B', 'D']);
  expect(existsSync(join(f.home, '.jarvis'))).toBe(false);
  for (const lanes of [['A', 'A'], ['E'], []]) await expect(runReview({ ...f, lanes })).rejects.toThrow(/lanes/);
  await expect(runReview({ ...f, round: '../escape' })).rejects.toThrow(/round/);
});
it('never overwrites old status or workspace and fails spawn errors', async () => {
  const f = fixture(); const rd = join(f.home, '.jarvis/codex-review', f.round);
  mkdirSync(rd, { recursive: true }); writeFileSync(join(rd, 'status'), 'old');
  await expect(runReview(f)).rejects.toThrow(/already|exists/);
  expect(readFileSync(join(rd, 'status'), 'utf8')).toBe('old');
  const g = fixture(); const r = await runReview({ ...g, codex: join(g.home, 'missing') });
  expect(r.exitCode).toBe(1);
  expect(readFileSync(join(r.roundDir, 'status'), 'utf8')).toContain('lane A exit 127');
});
it('failed evidence cannot pass even when reviewers pass', async () => {
  const f = fixture(); f.evidence[1]!.args = ['-e', 'process.exit(3)'];
  const r = await runReview(f);
  expect(r.exitCode).toBe(1);
  expect(inspectReviews(join(f.home, '.jarvis/codex-review')).rounds[0].result).toBe('FAIL');
});
it('reserves a round atomically against duplicate workers', async () => {
  const f = fixture();
  const first = runReview(f);
  await expect(runReview(f)).rejects.toThrow(/already|exists/);
  expect((await first).exitCode).toBe(0);
});
it('refuses an occupied workspace or redirected output root', async () => {
  const f = fixture();
  const workspace = join(f.home, '.jarvis-work/reviews', `${f.round}-${f.git('rev-parse', 'HEAD').toString().trim()}`);
  mkdirSync(workspace, { recursive: true }); writeFileSync(join(workspace, 'keep'), 'keep');
  await expect(runReview(f)).rejects.toThrow(/workspace already/);
  expect(readFileSync(join(workspace, 'keep'), 'utf8')).toBe('keep');
  const g = fixture(); symlinkSync(g.repo, join(g.home, '.jarvis'));
  await expect(runReview(g)).rejects.toThrow(/unsafe output/);
});
it('a subset is diagnostic only and an extra lane must pass', async () => {
  const f = fixture();
  const r = await runReview({ ...f, lanes: ['A'] });
  expect(r.exitCode).toBe(1);
  expect(inspectReviews(join(f.home, '.jarvis/codex-review')).rounds[0].problems.join(' ')).toContain('required lanes B,D');
  const g = fixture(); writeFileSync(join(g.prompts, 'prompt-C.md'), 'FAIL');
  expect((await runReview({ ...g, lanes: ['A', 'B', 'C', 'D'] })).exitCode).toBe(1);
});
it('CLI prints every verdict path with the approved defaults', () => {
  const f = fixture(); const config = join(f.home, 'evidence.json');
  writeFileSync(config, JSON.stringify(f.evidence));
  const cli = spawnSync(process.execPath, [resolve('scripts/review-run.mjs'), '--round', f.round, '--repo', f.repo, '--prompts', f.prompts, '--schema', f.schema, '--codex', f.codex, '--evidence-config', config], { env: { HOME: f.home, PATH: '/opt/homebrew/bin:/usr/bin:/bin' }, encoding: 'utf8' });
  expect(cli.status).toBe(0);
  for (const lane of ['A', 'B', 'D']) expect(cli.stdout).toContain(`Lane ${lane} verdict: ${join(f.home, '.jarvis/codex-review', f.round, `verdict-${lane}.json`)}`);
});

it('dry run never refreshes the source index', async () => {
  const f = fixture();
  const before = readFileSync(join(f.repo, '.git/index'));
  utimesSync(join(f.repo, 'source.txt'), 1, 1);
  await runReview({ ...f, dryRun: true });
  expect(readFileSync(join(f.repo, '.git/index'))).toEqual(before);
});
it('reserves the manifest exclusively even without workspace or status', () => {
  const f = fixture(); const dir = join(f.home, 'reservation'); mkdirSync(dir);
  reserveLaneManifest(dir, ['A', 'B', 'D']);
  expect(() => reserveLaneManifest(dir, ['C'])).toThrow(/EEXIST/);
  expect(readFileSync(join(dir, 'lanes'), 'utf8')).toBe('lanes A,B,D\n');
});
it('records setup failure and refuses a symlinked response directory', async () => {
  const f = fixture();
  mkdirSync(join(f.repo, '.review-evidence')); writeFileSync(join(f.repo, '.review-evidence/existing'), 'x');
  f.git('add', '.'); f.git('commit', '-qm', 'reserved directory');
  await expect(runReview(f)).rejects.toThrow(/EEXIST/);
  const rd = join(f.home, '.jarvis/codex-review', f.round);
  expect(readFileSync(join(rd, 'status'), 'utf8')).toContain('runner-error');
  expect(inspectReviews(join(f.home, '.jarvis/codex-review')).rounds[0].result).toBe('FAIL');
  const g = fixture();
  g.git('mv', 'docs/reviews', 'docs/real-reviews'); symlinkSync('real-reviews', join(g.repo, 'docs/reviews'));
  g.git('add', '.'); g.git('commit', '-qm', 'symlink');
  await expect(runReview(g)).rejects.toThrow(/symlink/);
  expect(readFileSync(join(g.repo, 'docs/real-reviews/old-response.md'), 'utf8')).toBe('builder narrative');
});

// Codex review of the subset mutation check: review evidence is the gate, so its mutation check must
// confirm every catch on the full suite (a fast run exits 3).
it('runs the review evidence mutation check in confirm mode', () => {
  const m = DEFAULT_EVIDENCE.find((c: { name: string }) => c.name === 'mutation-check');
  expect(m.args).toEqual(['scripts/mutation-check.mjs', '--confirm']);
  expect(defaultEvidence().find((c: { name: string }) => c.name === 'mutation-check').args).toEqual(['scripts/mutation-check.mjs', '--confirm']);
});

// Decision 94: a stage review confirms its own stage's mutations.
it('passes --confirm-stage through to the mutation check, and refuses an unknown stage', async () => {
  const m = defaultEvidence({ confirmStage: '0-1' }).find((c: { name: string }) => c.name === 'mutation-check');
  expect(m.args).toEqual(['scripts/mutation-check.mjs', '--confirm-stage', '0-1']);
  expect(defaultEvidence({ confirmStage: '0-1' }).filter((c: { name: string }) => c.name !== 'mutation-check')).toEqual(DEFAULT_EVIDENCE.filter((c: { name: string }) => c.name !== 'mutation-check'));
  expect(() => defaultEvidence({ confirmStage: '4' })).toThrow(/stage/);
  const g = fixture();
  await expect(runReview({ ...g, evidence: undefined, confirmStage: '9', dryRun: true })).rejects.toThrow(/stage/);
});

// Codex review of decision 94, critical: a filtered mutation check is not review evidence.
it('refuses to start while JARVIS_MUTATIONS is set, before creating anything', async () => {
  const g = fixture();
  const before = process.env.JARVIS_MUTATIONS;
  process.env.JARVIS_MUTATIONS = '^tripwire';
  try {
    await expect(runReview({ ...g, dryRun: true })).rejects.toThrow(/JARVIS_MUTATIONS/);
    process.env.JARVIS_MUTATIONS = '';
    await expect(runReview({ ...g, dryRun: true })).rejects.toThrow(/JARVIS_MUTATIONS/);
  } finally {
    if (before === undefined) delete process.env.JARVIS_MUTATIONS; else process.env.JARVIS_MUTATIONS = before;
  }
  expect(existsSync(join(g.home, '.jarvis'))).toBe(false);
  expect(existsSync(join(g.home, '.jarvis-work'))).toBe(false);
  const r = spawnSync(process.execPath, ['scripts/review-run.mjs', '--round', 'stage0-1', '--prompts', g.prompts, '--schema', g.schema, '--repo', g.repo, '--dry-run'], { encoding: 'utf8', env: { ...process.env, JARVIS_MUTATIONS: 'x' } });
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/JARVIS_MUTATIONS/);
});

// Codex re-check of decision 94, high: parseArgs keeps only the last value, so a repeated flag picked a stage silently.
it('CLI reads every --confirm-stage token: a repeat in either spelling or any bad value is refused', () => {
  expect(parseCli(['--round', 'stage0-1', '--confirm-stage', '2', '--lanes', 'A,B', '--dry-run']).options).toMatchObject({ round: 'stage0-1', confirmStage: '2', lanes: ['A', 'B'], dryRun: true });
  expect(parseCli(['--round', 'stage0-1', '--confirm-stage=3']).options.confirmStage).toBe('3');
  expect(parseCli(['--round', 'stage0-1']).options.confirmStage).toBeUndefined();
  expect(() => parseCli(['--confirm-stage=typo', '--confirm-stage', '3', '--confirm-stage=2'])).toThrow(/once/);
  expect(() => parseCli(['--confirm-stage', '2', '--confirm-stage', '2'])).toThrow(/once/);
  expect(() => parseCli(['--confirm-stage=2', '--confirm-stage=3'])).toThrow(/once/);
  expect(() => parseCli(['--confirm-stage=typo'])).toThrow(/stage/);
  expect(() => parseCli(['--confirm-stage='])).toThrow(/stage/);
  const g = fixture();
  const r = spawnSync(process.execPath, ['scripts/review-run.mjs', '--round', 'stage0-1', '--prompts', g.prompts, '--schema', g.schema, '--repo', g.repo, '--dry-run', '--confirm-stage=typo', '--confirm-stage', '3', '--confirm-stage=2'], { encoding: 'utf8' });
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/--confirm-stage may be given only once/);
  expect(r.stdout).toBe('');
  // The CLI runs the review with those parsed options (split lanes, dry run, the stage).
  const ok = spawnSync(process.execPath, ['scripts/review-run.mjs', '--round', 'stage0-1', '--prompts', g.prompts, '--schema', g.schema, '--repo', g.repo, '--codex', g.codex, '--lanes', 'A,B', '--dry-run', '--confirm-stage', '2'], { encoding: 'utf8', env: { ...process.env, HOME: g.home } });
  expect(ok.stderr).toBe('');
  expect(ok.stdout).toMatch(/^Dry run: /);
});

it('CLI takes --confirm-stage', () => {
  const r = spawnSync(process.execPath, ['scripts/review-run.mjs', '--help'], { encoding: 'utf8' });
  expect(r.stdout).toContain('[--confirm-stage <0-1|2|3>]');
  const bad = spawnSync(process.execPath, ['scripts/review-run.mjs', '--round', 'stage0-1', '--prompts', '/nonexistent', '--schema', '/nonexistent', '--confirm-stage', '7'], { encoding: 'utf8' });
  expect(bad.status).toBe(1);
  expect(bad.stderr).toMatch(/stage/);
});
