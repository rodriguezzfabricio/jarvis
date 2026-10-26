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
// Every `.jarvis` rule ignores case: APFS, the default on macOS, does (decision 132).
const RUNNER_HOME_BASH = /(~|\$HOME|\/Users\/[^/\s]+)\/\.jarvis(\/|\s|$)/i;
const RUNNER_HOME = /(^~|\$HOME|^\/Users\/[^/]+|^\/home\/[^/]+)\/\.jarvis(\/|$)/i;
const JARVIS_PATH = /(^|\/)\.jarvis(\/|$)/i;

/** path is root or inside it, ignoring case. */
function within(path, root) {
  const p = path.toLowerCase(), r = root.toLowerCase();
  return p === r || p.startsWith(`${r}/`);
}

/** By spelling (~, $HOME, /Users/<u>, /home/<u>), or by the resolved path under this HOME, ".." included. */
function inRunnerHome(path, cwd, env) {
  if (RUNNER_HOME.test(path)) return true;
  if (!env.HOME || !isAbsolute(env.HOME)) return false;
  const home = join(resolve(env.HOME), ".jarvis");
  const full = resolve(typeof cwd === "string" ? cwd : "/", path);
  return within(full, home);
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
      if (within(dir, runnerHome)) return true;
      continue;
    }
    if (!/\.jarvis/i.test(t)) continue;
    const full = resolve(dir, expand(t));
    if (within(full, runnerHome)) return true;
  }
  return false;
}

/** The command with its quotes, backslashes and $'' / $"" splits taken out: `research-""fixtures` and `.jar\vis` read as written. */
export function shellWords(command) {
  return command.replace(/\$(?=['"])/g, "").replace(/["'\\]/g, "");
}

// Commands that change files, by name (lowercased: APFS finds CHMOD too), and the wrappers before them.
const MUTATORS = new Set(["chmod", "chown", "chgrp", "chflags", "xattr", "mv", "rm", "rmdir", "unlink", "ln", "link", "cp", "ditto",
  "install", "rsync", "tee", "truncate", "dd", "touch", "mkdir", "shred"]);
const WRAPPERS = new Set(["sudo", "doas", "env", "command", "builtin", "exec", "nohup", "time", "nice", "xargs"]);
// Commands that only create: they may name the session's area folders themselves (`mkdir -p .jarvis/notes`).
const CREATORS = new Set(["mkdir", "touch", "cp", "install"]);
const OPERATOR = /^[;&|()<>\n]+$/;
// The areas the session's own files live in (SESSION_FILES below); shared with the search rule.
const AREAS = "notes|scratch|intake|mockups|checks|onboard|sweep|release";
const IN_AREA = new RegExp(`(^|\\/)\\.jarvis\\/(${AREAS})(\\/|$)`, "i"); // an area folder, or anything in one
const BELOW_AREA = new RegExp(`(^|\\/)\\.jarvis\\/(${AREAS})\\/[^/]`, "i"); // strictly inside one

/**
 * Bash that changes a `.jarvis` path other than the session's own (decision 132): within one pipeline, a
 * changing command (the list above, `sed -i`, `perl -i`, `find -delete` or `-exec`) that names such a path,
 * or a redirection into one. Any command may name the session's own files and what is inside its areas;
 * a creating command (and mv's destination) may name an area folder itself; nothing changes `.jarvis`
 * itself, an area folder or a runner-owned path, and no link is made anywhere under `.jarvis`. Follows
 * plain `cd`. Best effort, like the rest: not a parser.
 */
function bashChangesJarvis(command, cwd, env) {
  const home = env.HOME && isAbsolute(env.HOME) ? resolve(env.HOME) : undefined;
  const expand = (w) => w.replace(/^(?:--?[\w-]+|[A-Za-z_]\w*)=/, "").replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home ?? "~");
  const strict = (p) => !JARVIS_PATH.test(p) || sessionOwned(p) || BELOW_AREA.test(p);
  const roomy = (p) => strict(p) || IN_AREA.test(p);
  const tokens = command.match(/[;&|()<>\n]+|[^\s;&|()<>`]+/g) ?? [];
  let dir = typeof cwd === "string" && isAbsolute(cwd) ? cwd : "/";
  let changes = false, names = false, head = true, prog = "", operands = [], target;
  const settle = () => { // judge the finished simple command's operands by its class
    const ok = prog === "ln" || prog === "link" ? [...operands, target ?? ""].every((p) => !JARVIS_PATH.test(p)) // a link could alias anything
      : CREATORS.has(prog) ? operands.every(roomy) && (target === undefined || roomy(target))
      : prog === "mv" && target === undefined ? operands.slice(0, -1).every(strict) && operands.slice(-1).every(roomy)
      : prog === "mv" ? operands.every(strict) && roomy(target)
      : operands.every(strict) && (target === undefined || strict(target));
    if (!ok) names = true;
    head = true; prog = ""; operands = []; target = undefined;
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const next = tokens[i + 1];
    if (OPERATOR.test(t)) {
      if (t.includes(">")) { if (next !== undefined && !OPERATOR.test(next)) { if (!strict(resolve(dir, expand(next)))) return true; i++; } continue; }
      if (t.includes("<")) { if (next !== undefined && !OPERATOR.test(next)) i++; continue; }
      settle();
      if (t === "|" || t === "|&") continue; // one pipeline: xargs and tee act on what came before
      if (changes && names) return true;
      changes = false; names = false;
      continue;
    }
    if (head) {
      if (/^[A-Za-z_]\w*=/.test(t)) continue; // an assignment before the command
      prog = t.slice(t.lastIndexOf("/") + 1).toLowerCase();
      if (WRAPPERS.has(prog)) continue;
      head = false;
      if (prog === "cd") {
        if (next === undefined || OPERATOR.test(next)) dir = home ?? dir;
        else { dir = resolve(dir, expand(next)); i++; }
      }
      if (MUTATORS.has(prog)) changes = true;
      continue;
    }
    if ((prog === "sed" || prog === "perl") && (/^-[a-zA-Z]*i/.test(t) || t.startsWith("--in-place"))) changes = true;
    if (prog === "find" && /^-(delete|exec|execdir|ok|okdir)$/.test(t)) changes = true;
    if (t === "-t" && next !== undefined && !OPERATOR.test(next)) { target = resolve(dir, expand(next)); i++; continue; }
    if (t.startsWith("--target-directory=")) { target = resolve(dir, expand(t)); continue; }
    if (t.startsWith("-") && !t.includes("=")) continue; // a flag
    operands.push(resolve(dir, expand(t)));
  }
  settle();
  return changes && names;
}

const GLOB = /[*?[{]/;

/** One path component of a shell glob as a regex, case-insensitive as APFS is; braces expand. */
function globPart(part) {
  let re = "";
  for (let i = 0; i < part.length; i++) {
    const c = part[i];
    const close = c === "[" ? part.indexOf("]", i + 2) : c === "{" ? part.indexOf("}", i + 1) : -1;
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[" && close > 0) { re += `[${part.slice(i + 1, close).replace(/^!/, "^").replace(/[\\\]]/g, "\\$&")}]`; i = close; }
    else if (c === "{" && close > 0) { re += `(?:${part.slice(i + 1, close).split(",").map((s) => globPart(s).source.slice(1, -1)).join("|")})`; i = close; }
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

/** A path component that is name, or a glob that could expand to it (`*`, `?` and `[…]` skip a leading dot, as shells do). */
function couldName(part, name) {
  if (!GLOB.test(part)) return part.toLowerCase() === name;
  if (name.startsWith(".") && !/^[.{[]/.test(part)) return false;
  try { return globPart(part).test(name); } catch { return true; }
}

/** A path with a glob in its `.jarvis` or next component that could expand into `.jarvis/research-fixtures`. */
function globsIntoFixtures(path) {
  const parts = path.split("/");
  return parts.some((part, k) => k + 1 < parts.length && (GLOB.test(part) || GLOB.test(parts[k + 1]))
    && couldName(part, ".jarvis") && couldName(parts[k + 1], "research-fixtures"));
}

/** Bash naming the fixtures without spelling them: any word, followed through plain `cd`, at `.jarvis/research…` or globbing into the fixtures. */
function bashNamesFixtures(command, cwd, env) {
  const home = env.HOME && isAbsolute(env.HOME) ? resolve(env.HOME) : undefined;
  const expand = (w) => w.replace(/^(?:--?[\w-]+|[A-Za-z_]\w*)=/, "").replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home ?? "~");
  const tokens = command.match(/[;&|()<>\n]+|[^\s;&|()<>`]+/g) ?? [];
  let dir = typeof cwd === "string" && isAbsolute(cwd) ? cwd : "/";
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (OPERATOR.test(t)) continue;
    const full = resolve(dir, expand(t));
    if (/\.jarvis\/research/i.test(full) || globsIntoFixtures(full)) return true;
    if (t === "cd") {
      const next = tokens[i + 1];
      if (next === undefined || OPERATOR.test(next)) dir = home ?? dir;
      else { dir = resolve(dir, expand(next)); }
    }
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
  return SESSION_OWNED.test(path.toLowerCase()) && !/(^|\/)\.\.(\/|$)/.test(path);
}

// A Glob pattern or Grep glob may search the areas those files live in, and nothing else under `.jarvis`.
const OWNED_AREAS = new RegExp(`^\\/(${AREAS})(\\/|$)|^\\/plan\\.json$`, "i");

function ownedSearch(pattern) {
  if (pattern.split("/").includes("..")) return false;
  return [...pattern.matchAll(/\.jarvis/gi)].every((m) =>
    (m.index === 0 || pattern[m.index - 1] === "/") && OWNED_AREAS.test(pattern.slice(m.index + m[0].length)));
}

// The run provider's recorded research (decision 132): one regular file per source directly in the
// project's `.jarvis/research-fixtures/`. Sessions may Read those files and list the folder with Glob; no
// tool and no Bash command may write there. In an unsandboxed interactive session this is a guard
// against mistakes, not the boundary: the eval's boundary is a post-run check of every fixture Read's
// returned bytes in the transcript against the original recording (backlog 155). A read must name a
// regular file with one link, directly in the session's own folder (same inode), with no symlink in any
// path component from the git toplevel down, so no link can alias the runner home. Grep recurses, so it
// gets no exception; a Glob pattern can't leave the folder.
const FIXTURE_FILE = new RegExp(`(^|\\/)\\.jarvis\\/research-fixtures\\/${NAME}$`, "i");
const FIXTURE_DIR = /(^|\/)\.jarvis\/research-fixtures\/?$/i;
const FIXTURES_NAMED = /research-fixtures/i;
const FIXTURES_READ_ONLY = "the recorded research fixtures are read-only: Read their files and list them with Glob";

/**
 * The session's fixture folder, under the nearest `.jarvis` from the cwd up to its git toplevel (a real
 * folder in a real `.jarvis`), and that toplevel: the folder holding `.git`, or else the one holding `.jarvis`.
 */
function fixtureFolder(cwd) {
  let folder, holder;
  for (let d = realpathSync.native(cwd); ; d = dirname(d)) {
    if (!folder) {
      const jarvis = lstatSync(join(d, ".jarvis"), { throwIfNoEntry: false });
      if (jarvis) {
        folder = jarvis.isDirectory() ? lstatSync(join(d, ".jarvis", "research-fixtures"), { throwIfNoEntry: false }) : undefined;
        if (!folder?.isDirectory()) return undefined;
        holder = d;
      }
    }
    if (marked(d, ".git")) return folder && { folder, top: lstatSync(d) };
    if (dirname(d) === d) return folder && { folder, top: lstatSync(holder) };
  }
}

/** dir, as spelled, is that folder: a directory with the folder's inode. */
function isFolder(dir, folder) {
  const own = lstatSync(dir, { throwIfNoEntry: false });
  return !!own?.isDirectory() && own.dev === folder.dev && own.ino === folder.ino;
}

/** No component of path, as spelled, is a symlink from the toplevel (by inode) down; never reaching it is a refusal. */
function linkFreeBelow(path, top) {
  for (let d = path; ; d = dirname(d)) {
    const own = lstatSync(d);
    if (own.isSymbolicLink()) return false;
    if (own.dev === top.dev && own.ino === top.ino) return true;
    if (dirname(d) === d) return false;
  }
}

function fixtureRead(tool, ti, cwd) {
  try {
    if (typeof cwd !== "string" || !isAbsolute(cwd)) return false;
    const found = fixtureFolder(cwd);
    if (!found) return false;
    const { folder, top } = found;
    if (tool === "Read") {
      const p = String(ti.file_path ?? "");
      if (!FIXTURE_FILE.test(p) || p.split("/").includes("..")) return false;
      const target = resolve(cwd, p);
      const file = lstatSync(target, { throwIfNoEntry: false });
      return !!file?.isFile() && file.nlink === 1 && isFolder(dirname(target), folder) && linkFreeBelow(target, top);
    }
    if (tool === "Glob") {
      const p = String(ti.path ?? ""), pattern = String(ti.pattern ?? "");
      if (!FIXTURE_DIR.test(p) || p.split("/").includes("..")) return false;
      if (pattern === "" || pattern.includes("/") || pattern.includes("**") || pattern.includes("..")) return false;
      return isFolder(resolve(cwd, p), folder) && linkFreeBelow(resolve(cwd, p), top);
    }
    return false;
  } catch { return false; } // anything unreadable is refused
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
  const text = tool === "Bash" ? String(ti.command ?? "") : tool === "Glob" ? String(ti.path ?? "") : String(ti.file_path ?? ti.path ?? ti.pattern ?? "");
  // Glob's pattern and Grep's glob name paths too, beside (or for Glob, instead of) the path they search from.
  const also = tool === "Glob" ? [String(ti.pattern ?? "")] : tool === "Grep" && ti.glob !== undefined ? [String(ti.glob)] : [];
  if (tool !== "Bash" && inRunnerHome(text, input?.cwd, env)) return OFF_LIMITS;
  if (also.some((t) => inRunnerHome(t, input?.cwd, env))) return OFF_LIMITS;
  const words = tool === "Bash" ? shellWords(text) : ""; // the command as Bash reads it, quotes and backslashes out
  if (tool === "Bash" && bashInRunnerHome(words, input?.cwd, env)) return OFF_LIMITS;
  if (!isJarvisSession(input, env)) return undefined;
  if (tool !== "Bash") {
    const pathOk = !JARVIS_PATH.test(text) || sessionOwned(text) || fixtureRead(tool, ti, input?.cwd);
    const searchOk = also.every((t) => !/\.jarvis/i.test(t) || ownedSearch(t));
    return pathOk && searchOk ? undefined : OFF_LIMITS;
  }
  if (FIXTURES_NAMED.test(words)) return FIXTURES_READ_ONLY;
  if (bashNamesFixtures(words, input?.cwd, env)) return FIXTURES_READ_ONLY;
  if (bashChangesJarvis(words, input?.cwd, env)) return "only the session's own .jarvis files may change";
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
