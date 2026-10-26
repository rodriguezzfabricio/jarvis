// PreToolUse tripwire (decision 12, layer 3). Not a wall: the sandbox and the broker are the walls.
// This catches obvious mistakes early with a clear message. Exit 2 blocks the tool call; stderr goes
// back to the model as the reason.
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const OFF_LIMITS = "the runner-owned folder is off limits";

// Hard stops, enforced in Jarvis sessions only (see isJarvisSession).
export const RULES = [
  [/\bgit\s+push\b[^\n;&|]*\s(--force\b|--force-with-lease\b|-f\b)/, "force-push is a hard stop; use `jarvis act git.push_protected` with approval"],
  [/\bgit\s+push\b/, "pushing is the runner's job; commit nothing and let the runner record the revision"],
  [/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)[a-zA-Z]*\s+(\/|~|\$HOME|\.\.)(\s|$|\/)/, "recursive delete outside the worktree"],
  [/\b(vercel|netlify)\b[^\n;&|]*\s--prod\b/, "production deploys go through the broker (`jarvis act deploy.promote`)"],
  [/\b(npm|pnpm|yarn)\s+publish\b/, "publishing packages is a hard stop"],
  [/\b(drizzle-kit\s+push|prisma\s+db\s+push|prisma\s+migrate\s+deploy)\b/, "schema pushes to a real database are a hard stop"],
  [/\bgh\s+(repo\s+create|release\s+create|pr\s+merge)\b/, "remote GitHub changes go through the broker"],
  [/\b(sendmail|mail\s+-s|swaks)\b/, "sending mail goes through the broker (`jarvis act email.send`)"],
  [/\bsecurity\s+(find|dump)-(generic|internet)-password\b/, "reading the Keychain is not allowed"],
];

// The runner home holds the ledger, evidence and secrets: off limits in every session, Jarvis or not.
const RUNNER_HOME_BASH = /(~|\$HOME|\/Users\/[^/\s]+)\/\.jarvis(\/|\s|$)/;
const RUNNER_HOME = /(^~|\$HOME|^\/Users\/[^/]+|^\/home\/[^/]+)\/\.jarvis(\/|$)/;

/** By spelling (~, $HOME, /Users/<u>, /home/<u>), or by the resolved path under this HOME, ".." included. */
function inRunnerHome(path, cwd, env) {
  if (RUNNER_HOME.test(path)) return true;
  if (!env.HOME || !isAbsolute(env.HOME)) return false;
  const home = join(resolve(env.HOME), ".jarvis");
  const full = resolve(typeof cwd === "string" ? cwd : "/", path);
  return full === home || full.startsWith(`${home}/`);
}

/**
 * Bash: the spelling rule, plus every operand that mentions `.jarvis` resolved against the cwd and HOME,
 * following plain `cd` commands (`cd`, `cd ~`, `cd $HOME`, `cd dir`). Straightforward forms only: this is
 * a tripwire, not a parser; the task sandbox is the wall.
 */
function bashInRunnerHome(command, cwd, env) {
  if (RUNNER_HOME_BASH.test(command)) return true;
  if (!env.HOME || !isAbsolute(env.HOME)) return false;
  const home = resolve(env.HOME);
  const runnerHome = join(home, ".jarvis");
  const expand = (w) => w.replace(/^(?:--?[\w-]+|[A-Za-z_]\w*)=/, "").replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home);
  const operator = (t) => /^[;&|()<>\n]+$/.test(t);
  const tokens = command.match(/[;&|()<>\n]+|[^\s;&|()<>'"`]+/g) ?? [];
  let dir = typeof cwd === "string" && isAbsolute(cwd) ? cwd : "/";
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (operator(t)) continue;
    if (t === "cd") {
      const next = tokens[i + 1];
      if (next === undefined || operator(next)) dir = home;
      else { dir = resolve(dir, expand(next)); i++; }
      if (dir === runnerHome || dir.startsWith(`${runnerHome}/`)) return true;
      continue;
    }
    if (!t.includes(".jarvis")) continue;
    const full = resolve(dir, expand(t));
    if (full === runnerHome || full.startsWith(`${runnerHome}/`)) return true;
  }
  return false;
}

// The files sessions may own under the repo's `.jarvis/`: a task session's notes (architecture §5) and
// scratch scripts (decision 68: a script instead of a refused compound command), and what the skills
// write there: intake rounds, answers and the taste draft; design mockups; the planner's plan and
// check proposals; the onboard and sweep reports and plans; the ship skill's release manifest (the runner
// takes its targets from its own config, never from it). None of them is authority: candidates
// touching `.jarvis/` are refused and the runner reads its own copies (decisions 87, 91). Every other
// `.jarvis/` name stays refused, except read-only access to the recorded research fixtures (below).
// Never through "..".
const NAME = "[A-Za-z0-9_-][A-Za-z0-9._-]*";
const SESSION_FILES = [
  `notes\\/${NAME}\\.md`,
  `scratch\\/${NAME}`,
  "intake\\/(round|answers)-[1-9][0-9]*\\.json",
  "intake\\/taste\\.json",
  "mockups\\/index\\.html",
  `mockups\\/${NAME}\\/${NAME}\\.(md|html|png)`,
  "plan\\.json",
  `checks\\/${NAME}\\.(check\\.json|sh|mjs|js|cjs)`,
  `checks\\/(fixtures|expected)(\\/${NAME})+`,
  "(onboard|sweep)\\/([0-9]{4}-[0-9]{2}-[0-9]{2}\\.md|plan\\.json)",
  "release\\/manifest\\.json",
];
const SESSION_OWNED = new RegExp(`(^|\\/)\\.jarvis\\/(${SESSION_FILES.join("|")})$`);

function sessionOwned(path) {
  return SESSION_OWNED.test(path) && !/(^|\/)\.\.(\/|$)/.test(path);
}

// The run provider's recorded research (decision 132): one file per source directly in
// `.jarvis/research-fixtures/`. Sessions may list, search and read them, never write them, so a
// session can't plant its own evidence. No subfolders, hidden files or "..".
const READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep"]);
const FIXTURES = new RegExp(`(^|\\/)\\.jarvis\\/research-fixtures(\\/|\\/(${NAME}|\\*|\\*\\.md))?$`);

function fixtureRead(tool, path) {
  return READ_ONLY_TOOLS.has(tool) && FIXTURES.test(path) && !/(^|\/)\.\.(\/|$)/.test(path);
}

/** A marker that exists as any kind of entry (a symlink, even a dangling one), or can't be checked. */
function marked(dir, name) {
  try {
    return lstatSync(join(dir, name), { throwIfNoEntry: false }) !== undefined;
  } catch { return true; } // an unreadable marker counts as present
}

/**
 * The plugin installs at user scope, so this hook runs in every Claude Code session. It enforces only in
 * Jarvis sessions: runner-started ones (JARVIS_SESSION=1), and those whose cwd, or a folder between it and
 * its git toplevel, holds `.jarvis` or `.jarvis-routing.json`. The toplevel is the nearest folder with a
 * `.git` entry, found by walking up as config/project.ts does, without running git. Outside a git repo
 * only the cwd counts, so the runner home's own `.jarvis/` doesn't make every folder under it Jarvis.
 * Anything it can't read counts as Jarvis: the check fails toward blocking.
 */
export function isJarvisSession(input, env) {
  if (env.JARVIS_SESSION === "1") return true;
  let dir;
  try {
    dir = realpathSync.native(resolve(input?.cwd ?? process.cwd()));
  } catch { return true; } // an unreadable cwd fails closed
  const chain = [];
  for (let d = dir; ; d = dirname(d)) {
    chain.push(d);
    if (marked(d, ".git")) break;
    if (dirname(d) === d) { chain.length = 1; break; }
  }
  return chain.some((d) => marked(d, ".jarvis") || marked(d, ".jarvis-routing.json"));
}

export function check(input, env = process.env) {
  const tool = input?.tool_name;
  const ti = input?.tool_input ?? {};
  const text = tool === "Bash" ? String(ti.command ?? "") : String(ti.file_path ?? ti.path ?? ti.pattern ?? "");
  if (tool !== "Bash" && inRunnerHome(text, input?.cwd, env)) return OFF_LIMITS;
  if (tool === "Bash" && bashInRunnerHome(text, input?.cwd, env)) return OFF_LIMITS;
  if (!isJarvisSession(input, env)) return undefined;
  if (tool !== "Bash" && /(^|\/)\.jarvis(\/|$)/.test(text) && !sessionOwned(text) && !fixtureRead(tool, text)) return OFF_LIMITS;
  if (tool !== "Bash") return undefined;
  for (const [re, why] of RULES) if (re.test(text)) return why;
  return undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.exit(0); // not our input: never break the session over a parse problem
  }
  const why = check(input);
  if (why) {
    process.stderr.write(`Jarvis tripwire: ${why}.\n`);
    process.exit(2);
  }
  process.exit(0);
}
