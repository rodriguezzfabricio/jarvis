import { describe, expect, it } from 'vitest';
import { inspectCompatibility } from '../../packages/cli/src/harness/claude/desktop-evidence.ts';

const expected = {
  workspace: '/Users/test/.jarvis-work/desktop-check/run-1',
  pluginDir: '/Users/test/jarvis/plugin',
  probeCommand: "printf '%s\\n' 'npm publish'",
  notBefore: '2026-10-24T15:00:00.000Z',
};
const receipt = 'Jarvis plugin: SessionStart ran (no run header).\n';
const command = `node "${expected.pluginDir}/hooks/session-start.mjs"`;
const denied = `PreToolUse:Bash hook error: [node "${expected.pluginDir}/hooks/tripwire.mjs"]: Jarvis tripwire: publishing packages is a hard stop.\n\nThis hook comes from the jarvis@jarvis plugin.`;
const jsonl = (events: unknown[]) => events.map(e => JSON.stringify(e)).join('\n') + '\n';
function desktop() {
  const common = { cwd: expected.workspace, sessionId: 'session-1', version: '2.1.308', timestamp: '2026-10-24T15:01:00.000Z', entrypoint: 'sdk-cli' };
  return [
    { ...common, type: 'attachment', attachment: { type: 'hook_success', hookEvent: 'SessionStart', hookName: 'SessionStart:startup', exitCode: 0, command, stdout: receipt, content: receipt } },
    { ...common, type: 'assistant', message: { content: [{ type: 'tool_use', id: 'read-1', name: 'Bash', input: { command: expected.probeCommand } }] } },
    { ...common, type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read-1', is_error: true, content: denied }] } },
  ];
}
function cli() {
  return [
    { type: 'system', subtype: 'hook_response', session_id: 'cli-1', hook_event: 'SessionStart', exit_code: 0, outcome: 'success', stdout: receipt, output: receipt },
    { type: 'system', subtype: 'init', session_id: 'cli-1', cwd: expected.workspace, claude_code_version: '2.1.309', plugins: [{ name: 'jarvis', path: expected.pluginDir }] },
    { type: 'assistant', session_id: 'cli-1', message: { content: [{ type: 'tool_use', id: 'read-1', name: 'Bash', input: { command: expected.probeCommand } }] } },
    { type: 'user', session_id: 'cli-1', message: { content: [{ type: 'tool_result', tool_use_id: 'read-1', is_error: true, content: denied.replace('jarvis@jarvis', 'jarvis@inline') }] } },
    { type: 'result', session_id: 'cli-1', subtype: 'success', is_error: false },
  ];
}

describe('desktop plugin compatibility uses harness evidence, never model claims', () => {
  it('accepts desktop hook receipt and a linked tripwire result', () => {
    expect(inspectCompatibility(jsonl(desktop()), expected, 'desktop')).toMatchObject({ pass: true, sessionStart: true, tripwire: true, version: '2.1.308' });
  });
  it('accepts the same plugin proof from pinned CLI stream records', () => {
    expect(inspectCompatibility(jsonl(cli()), expected, 'cli')).toMatchObject({ pass: true, sessionStart: true, tripwire: true, version: '2.1.309' });
  });
  it('does not accept copied receipts or errors in assistant text', () => {
    const events = JSON.parse(JSON.stringify(desktop()));
    events[0] = { ...events[1], message: { content: [{ type: 'text', text: receipt + denied }] } } as typeof events[0];
    expect(inspectCompatibility(jsonl(events), expected, 'desktop').pass).toBe(false);
    expect(inspectCompatibility(jsonl([{ ...events[1], message: { content: [{ type: 'text', text: jsonl(desktop()) }] } }]), expected, 'desktop').pass).toBe(false);
  });
  it('rejects a missing hook or a generic permission denial', () => {
    expect(inspectCompatibility(jsonl(desktop().slice(1)), expected, 'desktop').pass).toBe(false);
    const events = JSON.parse(JSON.stringify(desktop()));
    events[2].message.content[0].content = 'File is denied by your permission settings';
    expect(inspectCompatibility(jsonl(events), expected, 'desktop').pass).toBe(false);
  });
  it('requires matching tool id, probe path and error status', () => {
    for (const change of ['id', 'path', 'status']) {
      const events = JSON.parse(JSON.stringify(desktop()));
      if (change === 'id') events[2].message.content[0].tool_use_id = 'other';
      if (change === 'path') events[1].message.content[0].input.command = '/unrelated';
      if (change === 'status') events[2].message.content[0].is_error = false;
      expect(inspectCompatibility(jsonl(events), expected, 'desktop').pass).toBe(false);
    }
  });
  it('rejects unrelated workspace, stale records, and mixed sessions', () => {
    for (const change of ['cwd', 'timestamp', 'session']) {
      const events = JSON.parse(JSON.stringify(desktop()));
      if (change === 'cwd') for (const e of events) e.cwd = '/unrelated';
      if (change === 'timestamp') for (const e of events) e.timestamp = '2026-10-23T00:00:00Z';
      if (change === 'session') events[2].sessionId = 'other';
      expect(inspectCompatibility(jsonl(events), expected, 'desktop').pass).toBe(false);
    }
  });
  it('requires SessionStart success from the expected plugin hook', () => {
    for (const change of ['exit', 'event', 'command', 'receipt']) {
      const events = JSON.parse(JSON.stringify(desktop()));
      if (change === 'exit') events[0].attachment.exitCode = 2;
      if (change === 'event') events[0].attachment.hookEvent = 'Stop';
      if (change === 'command') events[0].attachment.command = 'node /another/plugin/hooks/session-start.mjs';
      if (change === 'receipt') events[0].attachment.stdout = events[0].attachment.content = '';
      expect(inspectCompatibility(jsonl(events), expected, 'desktop').pass).toBe(false);
    }
  });
  it('fails closed for partial, malformed or oversized records', () => {
    for (const text of [jsonl(desktop()) + '{', 'not json\n', jsonl(desktop()) + ' '.repeat(16 * 1024 * 1024)]) {
      expect(inspectCompatibility(text, expected, 'desktop').pass).toBe(false);
    }
  });
  it('requires pinned CLI version, expected plugin, and successful session completion', () => {
    for (const change of ['version', 'plugin', 'outcome']) {
      const events = JSON.parse(JSON.stringify(cli()));
      if (change === 'version') events[1].claude_code_version = '0.0.0';
      if (change === 'plugin') events[1].plugins[0].path = '/wrong';
      if (change === 'outcome') events.pop();
      expect(inspectCompatibility(jsonl(events), expected, 'cli').pass).toBe(false);
    }
  });
});

// Fault injection uses only synthetic modules; no model or network call is made.
describe('compatibility capture safety gate', () => {
  it('does not start a compatibility session when the live canary fails', async () => {
    const { vi } = await import('vitest');
    const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'compat-capture-'));
    const session = vi.fn();
    vi.doMock('../../packages/cli/src/harness/claude/probe.ts', () => ({ runCanaryProbe: vi.fn().mockResolvedValue({ ok: false, checks: [] }) }));
    vi.doMock('../../packages/cli/src/harness/claude/session.ts', () => ({ runSession: session }));
    try {
      const { captureCompatibility } = await import('../../packages/cli/src/harness/claude/desktop-evidence.ts');
      await expect(captureCompatibility({ ...expected, directory: dir, jarvisHome: '/synthetic/.jarvis', cacheDir: '/synthetic/cache' })).rejects.toThrow('live canary failed');
      expect(session).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(dir, 'stream.jsonl'))).toBe(false);
    } finally {
      vi.doUnmock('../../packages/cli/src/harness/claude/probe.ts'); vi.doUnmock('../../packages/cli/src/harness/claude/session.ts');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
