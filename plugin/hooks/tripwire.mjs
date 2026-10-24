// PreToolUse tripwire (decision 12, layer 3). Not a wall: the sandbox and the broker are the walls.
// This catches obvious mistakes early with a clear message. Exit 2 blocks the tool call; stderr goes
// back to the model as the reason.
import { readFileSync } from "node:fs";

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
  [/(~|\$HOME|\/Users\/[^/\s]+)\/\.jarvis(\/|\s|$)/, "the runner-owned folder is off limits"],
];

// A task session owns only its worktree's notes (architecture §5) and scratch scripts (decision 68:
// a script instead of a refused compound command). Never under a home folder, never through "..".
const RUNNER_HOME = /(^~|\$HOME|^\/Users\/[^/]+|^\/home\/[^/]+)\/\.jarvis(\/|$)/;
const SESSION_OWNED = /(^|\/)\.jarvis\/(notes\/[A-Za-z0-9_-][A-Za-z0-9._-]*\.md|scratch\/[A-Za-z0-9_-][A-Za-z0-9._-]*)$/;

function sessionOwned(path) {
  return SESSION_OWNED.test(path) && !RUNNER_HOME.test(path) && !/(^|\/)\.\.(\/|$)/.test(path);
}

export function check(input) {
  const tool = input?.tool_name;
  const ti = input?.tool_input ?? {};
  const text = tool === "Bash" ? String(ti.command ?? "") : String(ti.file_path ?? ti.path ?? ti.pattern ?? "");
  if (tool !== "Bash" && /(^|\/)\.jarvis(\/|$)/.test(text) && !sessionOwned(text)) return "the runner-owned folder is off limits";
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
