// A stand-in for the pinned Claude Code's `--version` and `plugin` commands, for the clean-install
// test. It keeps its marketplaces and plugins in $HOME/.fake-claude/state.json and logs every call
// (argv and environment variable names) to $HOME/.fake-claude/calls.jsonl. No credentials, no network.
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env.HOME;
if (!home) { console.error("fake claude: HOME is not set"); process.exit(9); }
const dir = join(home, ".fake-claude");
mkdirSync(dir, { recursive: true });
const args = process.argv.slice(2);
appendFileSync(join(dir, "calls.jsonl"), JSON.stringify({ args, envKeys: Object.keys(process.env).sort() }) + "\n");

const statePath = join(dir, "state.json");
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { marketplaces: [], plugins: [] };
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
const is = (...want) => want.length === args.length && want.every((w, i) => w === undefined || w === args[i]);

if (is("--version")) console.log("2.1.309 (Claude Code)");
else if (is("plugin", "marketplace", "list", "--json")) console.log(JSON.stringify(state.marketplaces));
else if (is("plugin", "list", "--json")) console.log(JSON.stringify(state.plugins));
else if (is("plugin", "marketplace", "add", undefined, "--scope", "user")) {
  const path = args[3];
  const { name } = JSON.parse(readFileSync(join(path, ".claude-plugin", "marketplace.json"), "utf8"));
  if (state.marketplaces.some((m) => m.name === name)) { console.error(`marketplace ${name} already exists`); process.exit(1); }
  state.marketplaces.push({ name, source: "directory", path, installLocation: path });
  save();
  console.log(`Added marketplace ${name}`);
} else if (is("plugin", "install", "jarvis@jarvis", "--scope", "user")) {
  const market = state.marketplaces.find((m) => m.name === "jarvis");
  if (!market) { console.error("no marketplace named jarvis"); process.exit(1); }
  const entry = JSON.parse(readFileSync(join(market.path, ".claude-plugin", "marketplace.json"), "utf8")).plugins.find((p) => p.name === "jarvis");
  if (!entry) { console.error("marketplace jarvis has no plugin named jarvis"); process.exit(1); }
  const folder = join(market.path, entry.source);
  const { version } = JSON.parse(readFileSync(join(folder, ".claude-plugin", "plugin.json"), "utf8"));
  // Like 2.1.309 (tests/live/plugin-install.live.test.ts checks the real one): the plugin folder is
  // copied into the cache with symlinks followed, so plugin/skills -> ../skills arrives as real files.
  const installPath = join(home, ".claude", "plugins", "cache", "jarvis", "jarvis", version);
  cpSync(folder, installPath, { recursive: true, dereference: true });
  state.plugins.push({ id: "jarvis@jarvis", version, scope: "user", enabled: true, installPath, readFromFolder: folder });
  save();
  console.log("Installed jarvis@jarvis");
} else {
  console.error(`fake claude: unsupported call: ${args.join(" ")}`);
  process.exit(9);
}
