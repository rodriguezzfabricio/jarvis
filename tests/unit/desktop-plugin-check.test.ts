import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { lstatSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error standalone host script
import { prepareCheck, loadCheck, verifyCheck } from '../../scripts/desktop-plugin-check.mjs';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'desktop-kit-')); roots.push(home);
  const pluginDir = join(home, 'repo/plugin'); mkdirSync(join(pluginDir, 'hooks'), { recursive: true }); mkdirSync(join(pluginDir, '.claude-plugin'));
  for (const name of ['hooks/session-start.mjs', 'hooks/tripwire.mjs', 'hooks/hooks.json', '.claude-plugin/plugin.json']) writeFileSync(join(pluginDir, name), 'synthetic');
  return { home, pluginDir, runId: 'run-1' };
}
describe('desktop compatibility kit host orchestration', () => {
  it('prepares isolated workspace and exact policy without changing desktop settings', () => {
    const options = fixture(); const run = prepareCheck(options);
    expect(run.workspace).toBe(join(options.home, '.jarvis-work/desktop-check/run-1'));
    expect(existsSync(join(run.workspace, '.claude/settings.json'))).toBe(false);
    const settings = JSON.parse(readFileSync(join(run.directory, 'settings.json'), 'utf8'));
    expect(settings.sandbox.failIfUnavailable).toBe(true);
    expect(settings.sandbox.allowUnsandboxedCommands).toBe(false);
    expect(settings.autoMemoryEnabled).toBe(false);
    expect(readFileSync(join(run.workspace, 'PROMPT.txt'), 'utf8')).toContain("npm publish");
    // A desktop chat carries no JARVIS_SESSION: the marker makes it a Jarvis session, so the tripwire denies.
    expect(lstatSync(join(run.workspace, '.jarvis'), { throwIfNoEntry: false })?.isDirectory()).toBe(true);
    expect(loadCheck(run.directory, options.home)).toEqual(run);
  });
  it('refuses reused ids and path traversal before writing', () => {
    const options = fixture(); prepareCheck(options);
    expect(() => prepareCheck(options)).toThrow();
    for (const runId of ['../outside', '/absolute', '.', '']) expect(() => prepareCheck({ ...options, runId })).toThrow();
  });
  it('rejects tampered host manifest paths and plugin changes', () => {
    const options = fixture(); const run = prepareCheck(options);
    writeFileSync(join(run.directory, 'run.json'), JSON.stringify({ ...run, workspace: '/unrelated' }));
    expect(() => loadCheck(run.directory, options.home)).toThrow();
    writeFileSync(join(run.directory, 'run.json'), JSON.stringify(run));
    writeFileSync(join(options.pluginDir, 'hooks/tripwire.mjs'), 'changed');
    expect(() => loadCheck(run.directory, options.home)).toThrow();
  });
  it('rejects changed plugin manifest and symlink ancestors before creating run folders', () => {
    const options = fixture(); const run = prepareCheck(options);
    writeFileSync(join(options.pluginDir, '.claude-plugin/plugin.json'), 'changed');
    expect(() => loadCheck(run.directory, options.home)).toThrow();
    const other = fixture(); const target = join(other.home, 'target'); mkdirSync(target);
    symlinkSync(target, join(other.home, '.jarvis-work'));
    expect(() => prepareCheck(other)).toThrow();
    expect(existsSync(join(target, 'desktop-check'))).toBe(false);
  });
  it('never reports PASS without both independently captured channels', () => {
    const options = fixture(); const run = prepareCheck(options);
    expect(verifyCheck(run.directory, undefined, options.home)).toMatchObject({ pass: false });
    expect(existsSync(join(run.directory, 'verdict.json'))).toBe(false);
  });
  it('requires valid evidence in both channels and rejects copied or failed evidence', () => {
    const options = fixture(); const run = prepareCheck(options);
    const receipt = 'Jarvis plugin: SessionStart ran (no run header).\n';
    const common = { cwd: run.workspace, sessionId: 's1', version: '2.1.308', timestamp: new Date().toISOString(), entrypoint: 'sdk-cli' };
    const denied = `PreToolUse:Bash hook error: [node "${run.pluginDir}/hooks/tripwire.mjs"]: Jarvis tripwire: publishing packages is a hard stop.\n\nThis hook comes from the jarvis@jarvis plugin.`;
    const assistant = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id: 't1', input: { command: run.probeCommand } }] } };
    const user = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: denied }] } };
    const desktop = [
      { type: 'attachment', attachment: { type: 'hook_success', hookEvent: 'SessionStart', hookName: 'SessionStart:startup', exitCode: 0, command: `node "${run.pluginDir}/hooks/session-start.mjs"`, stdout: receipt } }, assistant, user,
    ].map(e => ({ ...common, ...e }));
    const cli = [
      { type: 'system', subtype: 'init', cwd: run.workspace, claude_code_version: '2.1.309', plugins: [{ name: 'jarvis', path: run.pluginDir }] },
      { type: 'system', subtype: 'hook_response', hook_event: 'SessionStart', exit_code: 0, outcome: 'success', stdout: receipt }, assistant,
      JSON.parse(JSON.stringify(user).replace('jarvis@jarvis', 'jarvis@inline')),
      { type: 'result', subtype: 'success', is_error: false },
    ].map(e => ({ ...e, session_id: 's2' }));
    const transcriptDir = join(options.home, '.claude/projects', run.workspace.replace(/[^a-zA-Z0-9]/g, '-'));
    mkdirSync(transcriptDir, { recursive: true }); const transcript = join(transcriptDir, 'session.jsonl');
    const lines = (events: unknown[]) => events.map(e => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(transcript, lines(desktop)); writeFileSync(join(run.directory, 'stream.jsonl'), lines(cli));
    writeFileSync(join(run.directory, 'probe.json'), JSON.stringify({ ok: true }));
    const outcome = { code: 0, timedOut: false, overflowed: false };
    writeFileSync(join(run.directory, 'outcome.json'), JSON.stringify(outcome));
    expect(verifyCheck(run.directory, transcript, options.home).pass).toBe(true);
    for (const field of ['code', 'timedOut', 'overflowed']) {
      writeFileSync(join(run.directory, 'outcome.json'), JSON.stringify({ ...outcome, [field]: field === 'code' ? 1 : true }));
      expect(verifyCheck(run.directory, transcript, options.home).pass).toBe(false);
    }
    writeFileSync(join(run.directory, 'outcome.json'), JSON.stringify(outcome));
    writeFileSync(join(run.directory, 'probe.json'), JSON.stringify({ ok: false }));
    expect(verifyCheck(run.directory, transcript, options.home).pass).toBe(false);
    writeFileSync(join(run.directory, 'probe.json'), JSON.stringify({ ok: true }));
    const copied = join(run.workspace, 'copy.jsonl'); writeFileSync(copied, lines(desktop));
    expect(verifyCheck(run.directory, copied, options.home).pass).toBe(false);
    writeFileSync(transcript, lines(desktop.slice(1)));
    expect(verifyCheck(run.directory, transcript, options.home).pass).toBe(false);
  });

});
