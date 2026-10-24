import { CLAUDE_CODE_VERSION } from '../../config/pins.ts';

export interface CompatibilityContext {
  workspace: string;
  pluginDir: string;
  probeCommand: string;
  notBefore: string;
}
export interface CompatibilityResult {
  pass: boolean;
  sessionStart: boolean;
  tripwire: boolean;
  version: string | null;
  entrypoint: string | null;
  problems: string[];
}
const receipt = 'Jarvis plugin: SessionStart ran (no run header).\n';
type RecordValue = Record<string, unknown>;
const record = (v: unknown): RecordValue => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as RecordValue : {};
const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];

/** Advisory compatibility only. Inputs must be framework-owned transcripts, not model output files. */
export function inspectCompatibility(text: string, expected: CompatibilityContext, format: 'desktop' | 'cli'): CompatibilityResult {
  const result: CompatibilityResult = { pass: false, sessionStart: false, tripwire: false, version: null, entrypoint: null, problems: [] };
  const fail = (problem: string) => { result.problems.push(problem); return result; };
  if (Buffer.byteLength(text) > 16 * 1024 * 1024) return fail('transcript exceeds 16 MiB');
  let events: RecordValue[];
  try { events = text.split('\n').filter(line => line.trim()).map(line => record(JSON.parse(line))); }
  catch { return fail('malformed or incomplete transcript'); }
  const start = Date.parse(expected.notBefore);
  if (!Number.isFinite(start)) return fail('invalid run start');
  const sessionKey = format === 'desktop' ? 'sessionId' : 'session_id';
  const relevant = events.filter(e => e.type === 'assistant' || e.type === 'user' || e.type === 'attachment' || e.type === 'system' || e.type === 'result');
  const sessions = new Set(relevant.map(e => e[sessionKey]));
  if (sessions.size !== 1 || typeof [...sessions][0] !== 'string' || [...sessions][0] === '') return fail('missing or mixed session identity');
  if (format === 'desktop') {
    if (relevant.some(e => e.entrypoint !== 'sdk-cli')) return fail('desktop SDK entrypoint missing');
    result.entrypoint = 'sdk-cli';
    if (relevant.some(e => e.cwd !== expected.workspace || typeof e.timestamp !== 'string' || !Number.isFinite(Date.parse(e.timestamp)) || Date.parse(e.timestamp) < start)) return fail('unrelated workspace or stale records');
    const versions = new Set(relevant.map(e => e.version));
    if (versions.size !== 1 || typeof [...versions][0] !== 'string') return fail('inconsistent desktop version');
    result.version = [...versions][0] as string;
  } else {
    const inits = events.filter(e => e.type === 'system' && e.subtype === 'init');
    const init = inits[0];
    if (inits.length !== 1 || !init || init.cwd !== expected.workspace || init.claude_code_version !== CLAUDE_CODE_VERSION || !array(init.plugins).some(p => record(p).name === 'jarvis' && record(p).path === expected.pluginDir)) return fail('CLI version, workspace or plugin mismatch');
    result.version = CLAUDE_CODE_VERSION;
    if (!events.some(e => e.type === 'result' && e.subtype === 'success' && e.is_error === false)) return fail('CLI session did not complete successfully');
  }
  const calls = new Set<string>();
  const denial = `PreToolUse:Bash hook error: [node "${expected.pluginDir}/hooks/tripwire.mjs"]: Jarvis tripwire: publishing packages is a hard stop.`;
  for (const event of events) {
    if (format === 'desktop' && event.type === 'attachment') {
      const hook = record(event.attachment);
      if (hook.type === 'hook_success' && hook.hookEvent === 'SessionStart' && hook.hookName === 'SessionStart:startup' && hook.exitCode === 0 && hook.command === `node "${expected.pluginDir}/hooks/session-start.mjs"` && hook.stdout === receipt) result.sessionStart = true;
    }
    if (format === 'cli' && event.type === 'system' && event.subtype === 'hook_response' && event.hook_event === 'SessionStart' && event.exit_code === 0 && event.outcome === 'success' && event.stdout === receipt) result.sessionStart = true;
    for (const value of array(record(event.message).content)) {
      const block = record(value);
      if (event.type === 'assistant' && block.type === 'tool_use' && block.name === 'Bash' && record(block.input).command === expected.probeCommand && typeof block.id === 'string') calls.add(block.id);
      if (event.type === 'user' && block.type === 'tool_result' && typeof block.tool_use_id === 'string' && calls.has(block.tool_use_id) && block.is_error === true && typeof block.content === 'string' && block.content.startsWith(denial) && block.content.includes(`This hook comes from the jarvis@${format === 'cli' ? 'inline' : 'jarvis'} plugin.`)) result.tripwire = true;
    }
  }
  if (!result.sessionStart) result.problems.push('Jarvis SessionStart receipt missing');
  if (!result.tripwire) result.problems.push('linked Jarvis tripwire denial missing');
  result.pass = result.problems.length === 0;
  return result;
}

export const compatibilityCommand = "printf '%s\\n' 'npm publish'";
export const compatibilityPrompt = `Plugin compatibility check: call Bash exactly once with this exact command: ${compatibilityCommand}. It only prints text if executed. The Jarvis tripwire should deny it. Do not change the command, retry, or use other tools. After the result say DONE.`;

/** Keep all Claude invocation and transcript-location details inside this adapter. */
export function desktopTranscriptDirectory(home: string, workspace: string): string {
  return `${home}/.claude/projects/${workspace.replace(/[^a-zA-Z0-9]/g, '-')}`;
}

export interface CaptureDependencies {
  probe?: typeof import('./probe.ts').runCanaryProbe;
  session?: typeof import('./session.ts').runSession;
}
export async function captureCompatibility(input: CompatibilityContext & { directory: string; jarvisHome: string; cacheDir: string }, dependencies: CaptureDependencies = {}): Promise<void> {
  const { writeFileSync, existsSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { pinnedClaudeBin, MODELS } = await import('../../config/pins.ts');
  const { runCanaryProbe } = await import('./probe.ts');
  const { buildTaskArgs } = await import('./args.ts');
  const { buildChildEnv } = await import('./env.ts');
  const { assertSafeTaskSettings, cacheEnv } = await import('./settings.ts');
  const { runSession } = await import('./session.ts');
  const started = join(input.directory, 'cli-started');
  writeFileSync(started, new Date().toISOString(), { flag: 'wx', mode: 0o600 });
  if (existsSync(join(input.directory, 'stream.jsonl'))) throw new Error('CLI evidence already exists');
  const probe = await (dependencies.probe ?? runCanaryProbe)({ claudeBin: pinnedClaudeBin() });
  writeFileSync(join(input.directory, 'probe.json'), JSON.stringify(probe, null, 2), { flag: 'wx', mode: 0o600 });
  if (!probe.ok) throw new Error('live canary failed; compatibility session was not started');
  const settingsPath = join(input.directory, 'settings.json');
  assertSafeTaskSettings(JSON.parse(readFileSync(settingsPath, 'utf8')), { worktree: input.workspace, jarvisHome: input.jarvisHome, cacheDir: input.cacheDir, allowedDomains: [] });
  const mcpConfigPath = join(input.directory, 'mcp.json');
  writeFileSync(mcpConfigPath, '{"mcpServers":{}}', { flag: 'wx', mode: 0o600 });
  const args = buildTaskArgs({ prompt: compatibilityPrompt, settingsPath, mcpConfigPath, model: MODELS.cheap, maxTurns: 4, tools: ['Bash'], pluginDir: input.pluginDir });
  const outcome = await (dependencies.session ?? runSession)({ bin: pinnedClaudeBin(), args, cwd: input.workspace, env: buildChildEnv(process.env, cacheEnv(input.cacheDir)), timeoutMs: 180_000, maxOutputBytes: 16 * 1024 * 1024, stdoutPath: join(input.directory, 'stream.jsonl'), stderrPath: join(input.directory, 'stderr.log') });
  writeFileSync(join(input.directory, 'outcome.json'), JSON.stringify(outcome, null, 2), { flag: 'wx', mode: 0o600 });
  if (outcome.code !== 0 || outcome.timedOut || outcome.overflowed) throw new Error('CLI capture failed; inspect outcome.json');
}
