/**
 * Child processes never inherit the runner's environment (decision 58).
 * Each one gets an environment built from an allowlist.
 */

const PASS_THROUGH = ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "SHELL", "TERM"] as const;

/** Fixed PATH for task sessions; never inherited. */
export function fixedPath(home: string): string {
  return [
    `${home}/.local/bin`,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");
}

const FORBIDDEN: readonly RegExp[] = [
  /^ANTHROPIC_API_KEY$/, // would bill the API instead of the plan
  /^ANTHROPIC_AUTH_TOKEN$/,
  /^ANTHROPIC_BASE_URL$/,
  /^CLAUDE_CODE_USE_/, // reroutes to another provider (Bedrock, Vertex, OpenAI-compatible…)
  /_BASE_URL$/,
  /^CLAUDE_CONFIG_DIR$/,
  /^CLAUDE_CODE_OAUTH_TOKEN$/,
];

export function isForbiddenEnvName(name: string): boolean {
  return FORBIDDEN.some((re) => re.test(name));
}

/** Names in `env` that must never reach a task session. */
export function findForbiddenEnv(env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.keys(env)
    .filter((k) => env[k] !== undefined && env[k] !== "" && isForbiddenEnvName(k))
    .sort();
}

export function buildChildEnv(
  parent: Readonly<Record<string, string | undefined>>,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASS_THROUGH) {
    const v = parent[name];
    if (v !== undefined) env[name] = v;
  }
  const home = env.HOME;
  if (!home) throw new Error("HOME must be set");
  env.PATH = fixedPath(home);
  for (const [k, v] of Object.entries(extra)) {
    if (isForbiddenEnvName(k)) throw new Error(`refusing to pass ${k} to a task session`);
    env[k] = v;
  }
  return env;
}
