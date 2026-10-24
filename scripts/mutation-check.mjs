// Breaks each safeguard in turn and checks that the unit suite catches it with failing assertions.
// Evidence for "tests test what they claim" (AGENTS.md; Codex stage 0 reviews 1 and 2).
// A mutation counts as caught only if: the unmodified control run passed, the mutated run collected
// the same number of tests, and at least one assertion failed. Crashes and collection errors are
// errors, never "caught". Every file is restored, even on failure.
// Two modes. Confirm mode (--confirm or JARVIS_MUTATION_CONFIRM=1) is the gate: every verdict comes
// from the full suite. The fast default first runs only the test files that can observe the mutated
// file (import graph plus files the tests name, scripts/mutation-select.mjs) against that set's own
// control; a survivor or an error there is re-run on the full suite, but a catch is kept unconfirmed
// (a test the selection can't see may still error on the full suite), so a fast run exits 3, never 0.
// Stage-scoped (--confirm-stage <stage>, decision 94): that stage's mutations and any from an unmapped
// definition file get confirm mode, the rest fast mode; it exits 0 only if everything is caught and
// every scoped mutation confirmed (stage map: scripts/mutation-stage.mjs).
// Usage: node scripts/mutation-check.mjs [--confirm | --confirm-stage 0-1|2|3]   (JARVIS_MUTATIONS=<regex> runs a subset, which exits 4: partial, not the gate;
//        JARVIS_MUTATION_JOBS=<n> runs n mutations at once in separate clones, default 1)
import { execFileSync, spawnSync } from "node:child_process";
import { globSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classify, summarize, testIds } from "./mutation-classify.mjs";
import { jobPlan, runAndRead, runPool, stopAll } from "./mutation-run.mjs";
import { buildGraph, collectedFiles, isCandidateTest, judge, relatedTests, subsetControls } from "./mutation-select.mjs";
import { DEFINITION_GLOBS, confirmFor, parseMode, tally } from "./mutation-stage.mjs";

const S = "packages/cli/src/harness/claude/settings.ts";
const A = "packages/cli/src/harness/claude/args.ts";
const P = "packages/cli/src/harness/claude/probe.ts";
const J = "packages/cli/src/harness/claude/streamjson.ts";
const X = "packages/cli/src/proc/session.ts";
const B = "packages/cli/src/eval/baseline.ts";
const G = "packages/cli/src/eval/git.ts";
const N = "packages/cli/src/eval/snapshot.ts";
const C = "packages/cli/src/eval/schedule.ts";
const L = "packages/cli/src/ledger/ledger.ts";
const K = "packages/cli/src/checks/store.ts";
const GT = "packages/cli/src/checks/gate.ts";
const BR = "packages/cli/src/broker/broker.ts";
const SR = "packages/cli/src/sandbox/srt.ts";
const TW = "plugin/hooks/tripwire.mjs";
const RS = "scripts/review-status.mjs";
const RR = "scripts/review-run.mjs";
const DE = "packages/cli/src/harness/claude/desktop-evidence.ts";
const DK = "scripts/desktop-plugin-check.mjs";

const mutations = [
  ["failIfUnavailable off", S, "      failIfUnavailable: true,\n      allowUnsandboxedCommands: false,\n      autoAllowBashIfSandboxed: true,\n      network: {\n        allowedDomains: [...input", "      failIfUnavailable: false,\n      allowUnsandboxedCommands: false,\n      autoAllowBashIfSandboxed: true,\n      network: {\n        allowedDomains: [...input"],
  ["auto-memory on", S, "  const settings: TaskSettings = {\n    autoMemoryEnabled: false,", "  const settings: TaskSettings = {\n    autoMemoryEnabled: true,"],
  ["reads outside worktree allowed", S, "      blockReadsOutsideWorkingDirectories: true,\n    },\n  };", "      blockReadsOutsideWorkingDirectories: false,\n    },\n  };"],
  ["git hooks writable", S, '          join(input.worktree, ".git", "hooks"),\n', ""],
  ["no --restricted", A, '    "--restricted",\n    "--tools",', '    "--tools",'],
  ["web tool allowed", A, 'export const BUILD_TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep"] as const;', 'export const BUILD_TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch"] as const;'],
  ["probe accepts 4xx as blocked", P, 'const blocked = allowedReached && f === "000" && denial;', 'const blocked = allowedReached && f !== "200" && denial;'],
  ["probe ignores sandbox denial record", P, 'const blocked = allowedReached && f === "000" && denial;', 'const blocked = allowedReached && f === "000";'],
  ["probe ignores project hooks", P, 'add("project_hooks_not_run", !existsSync(hookMarker),', 'add("project_hooks_not_run", true,'],
  ["probe ignores outside reads", P, 'add("outside_worktree_not_readable", !all.includes(outsideToken),', 'add("outside_worktree_not_readable", true,'],
  ["probe ignores plugin hooks", P, 'add("jarvis_plugin_hooks_run", existsSync(pluginMarker),', 'add("jarvis_plugin_hooks_run", true,'],
  ["session skips flush wait", X, "  await Promise.all(sinks);\n", ""],
  ["session ignores sink errors", X, '  if (sinkError) throw new EvidenceCaptureError', '  if (false) throw new EvidenceCaptureError'],
  ["baseline skips preflight", B, "  if (!pre.ok) throw new PreflightError", "  if (false) throw new PreflightError"],
  ["eval allowlist not enforced at run", B, "  checkEvalDomains(task.id, task.allowedDomains);\n", ""],
  ["task files widen the eval allowlist", B, "  checkEvalDomains(id, t.allowedDomains);\n", ""],
  ["eval allowlist gains a host", B, '"localhost", "127.0.0.1"];', '"localhost", "127.0.0.1", "api.github.com"];'],
  ["baseline shares one cache", B,'const cacheRoot = join(workRoot, "cache-runs", task.id, runId);', 'const cacheRoot = join(workRoot, "cache-runs", "shared");'],
  ["runner git runs hooks", G, '  "-c", "core.hooksPath=/dev/null",\n', ""],
  ["runner git runs fsmonitor", G, '  "-c", "core.fsmonitor=false",\n', ""],
  ["snapshot ignores credentials", N, "  if (found.length) {", "  if (false) {"],
  ["snapshot ignores inline comments", N, '      const c = line.slice(head.length).search(/\\s#/);', '      const c = -1;'],
  ["snapshot skips binary files", N, "  if (buf.includes(0)) {\n    const le", "  if (false) {\n    const le"],
  ["usage wait ignores windows", J, "  const over = Object.values(last.windows).filter((w) => w.utilization >= threshold);", "  const over: RateLimitWindow[] = [];"],
  ["placeholder rule exempts short passwords", N, "export function isPlaceholderPassword(raw: string): boolean {\n", "export function isPlaceholderPassword(raw: string): boolean {\n  if (raw.length <= 4) return true;\n"],
  ["snapshot ignores DER private keys", N, "    if (isDerPrivateKey(buf)) {", "    if (false) {"],
  ["snapshot ignores format encoding", N, "    const all = [...views, ...views.flatMap(decodedViews)];", "    const all = [...views];"],
  ["snapshot ignores credential fields", N, '        for (const h of findSecretFields(name, t)) if (i === 0 || !h.startsWith("unparseable")) hits.add(h);', "        void t;"],
  ["reference defaults are trusted", N, "  if (ref) return ref[1] === undefined || isInertString(ref[1]);", "  if (ref) return true;"],
  ["config files read line by line", N, "  const structured = /\\.(json|jsonc|json5|ya?ml|toml)$/i.test(name);", "  const structured = false;"],
  ["numeric passwords exempt", N, '  if (v === "") return true;\n', '  if (v === "" || /^\\d+$/.test(v)) return true;\n'],
  ["unparseable configs pass", N, 'return named ? ["unparseable configuration with credential-named fields"] : [];', "return [];"],
  ["JSON duplicate keys ignored", N, "      return hasDuplicateJsonKeys(t) ? undefined : { plain: [v] };", "      return { plain: [v] };"],
  ["YAML keeps only the last duplicate", N, "      return { yaml: list };", "      return { plain: list.map((d) => d.toJS() as unknown) };"],
  ["env assignments in strings ignored", N, "          if (m && isSecretName(m[1]!)", "          if (false && m && isSecretName(m[1]!)"],
  ["typed credential values pass", N, "      else hits.add(key);\n    };", "      else return;\n    };"],
  ["YAML aliases not followed", N, "        n = n.resolve(doc);", "        return undefined;"],
  ["YAML alias limit off", N, "        if (++aliases > MAX_YAML_ALIASES) {", "        if (false && ++aliases > MAX_YAML_ALIASES) {"],
  ["YAML alias keys not followed", N, "        const k = deref(doc, p.key);", "        const k = p.key;"],
  ["env entry name not carried to its values", N, '(k === "value" && envName ? envName : k)', "(k)"],
  ["npm _auth not a credential", N, " || /(^|[/:])_auth$/.test(k);", ";"],
  ["Yarn auth ident not a credential", N, "|auth_ident|", "|"],
  ["yarnrc read as INI", N, "  const yarn = /^\\.?yarnrc$/.test(name);", "  const yarn = false;"],
  ["base64 user:password not detected", N, "    if (isBase64UserPassword(m[0])) {", "    if (false) {"],
  ["base64 user part unrestricted", N, "/^([\\w.@+~!$%&*=#|-]*):([\\x21-\\x7e]+)$/", "/^([\\x21-\\x39\\x3b-\\x7e]*):([\\x21-\\x7e]+)$/"],
  ["YAML merges not expanded", N, '        if (key !== "<<") return [{ key, value: p.value }];', "        return [{ key, value: p.value }];"],
  ["Docker token fields not credentials", N, "|identitytoken|registrytoken|", "|"],
  ["Docker auths not inspected (JSON)", N, '        if (key === "auths") for (const r of Object.values(o))', "        if (false) for (const r of Object.values(o))"],
  ["Docker auths not inspected (YAML)", N, '        if (key === "auths")\n          for (const r of pairs) {', "        if (false)\n          for (const r of pairs) {"],
  ["ledger reads not checked for stability", L, "    if (head === before) return verifyText(text, head);", "    return verifyText(text, head);"],
  ["contended ledger reads not retried under the lock", L, "    return v.contended ? this.withLock(() => verifyLedger(this.dir)) : v;", "    return v;"],
  ["XML name/value not inspected", N, "      if (label === undefined || !isSecretName(label)) continue;", "      continue;"],
  ["XML name/value element text not read", N, '      if (value === undefined && m[3] !== "/") {', "      if (false) {"],
  [".config files not scanned", N, "|plist|xml|config|npmrc|", "|plist|xml|npmrc|"],
  ["Authorization headers not scanned", N, "    if (!isInertString(m[1]!) && !isPlaceholderAuth(m[1]!)) {", "    if (false) {"],
  ["Authorization field not a credential", N, "|authorization|key_data|", "|key_data|"],
  ["key data fields not credentials", N, "|authorization|key_data|", "|authorization|"],
  ["base64 runs not decoded", N, "    const hits = new Set([...all.flatMap(findCredentials), ...all.flatMap(findEncodedCredentials)]);", "    const hits = new Set(all.flatMap(findCredentials));"],
  ["decoded base64 not checked for DER keys", N, '    if (isDerPrivateKey(buf)) hits.add("base64-encoded private key");', '    if (false) hits.add("base64-encoded private key");'],
  ["auth placeholders flagged", N, "  return /^[\\w-]{0,8}(…|\\.\\.\\.)$/.test(v) ||", "  return false &&"],
  ["private JWK text patterns off", N, "  const hits = CREDENTIAL_PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);", '  const hits = CREDENTIAL_PATTERNS.filter(([n, re]) => n !== "private JWK" && re.test(text)).map(([name]) => name);'],
  ["private JWK structure ignored (JSON)", N, '        if (typeof o.kty === "string" && JWK_PRIVATE', '        if (false && typeof o.kty === "string" && JWK_PRIVATE'],
  ["private JWK structure ignored (YAML)", N, '        if (pairs.some((p) => p.key === "kty")', '        if (false && pairs.some((p) => p.key === "kty")'],
  ["INI continuation ignored", N, "    while (!yarn && i + 1 < lines.length", "    while (false && !yarn && i + 1 < lines.length"],
  ["extensionless files not scanned", N, "  if (!CONFIG_FILE.test(name) && !extensionless) return [];", "  if (!CONFIG_FILE.test(name)) return [];"],
  ["ASIA keys not recognized", N, "(?:AKIA|ASIA)[0-9A-Z]{16}", "(?:AKIA)[0-9A-Z]{16}"],
  ["shell references flagged", N, "  if (/^\\$(\\d+|[@*#?])$/.test(v) ||", "  if (false &&"],
  // Review-status summarizer (Codex, review-status-opus.md): advisory, but it must never show a false PASS.
  ["missing required evidence ignored", RS, "\"unit-tests\", \"live-probe\", \"doctor-live\"", "\"unit-tests\", \"doctor-live\""],
  ["fourth review lane ignored", RS, "let ids = parallel ? [\"A\", \"B\", \"C\", \"D\"] : [\"single\"];", "let ids = parallel ? [\"A\", \"B\", \"D\"] : [\"single\"];"],
  ["invalid verdict not reported", RS, "if (!valid) problems.push", "if (false) problems.push"],
  ["revision mismatch ignored", RS, "if (documented && inferred && documented !== inferred)", "if (false)"],
  ["missing completion marker ignored", RS, "if (exitCode === null) problems.push", "if (false) problems.push"],
  ["mixed help accepted", RS, "(help && args.length !== 1)", "false"],
  ["symlink entry point ignored", RS, "realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))", "resolve(process.argv[1]) === fileURLToPath(import.meta.url)"],
  ["FIFO open blocks", RS, "constants.O_RDONLY | constants.O_NONBLOCK", "\"r\""],
  ["review manifest ignored", RS, "    else ids = declared;", "    else ids = [\"A\", \"B\", \"C\", \"D\"];"],
  ["review required lanes ignored", RS, "    if (missing.length) problems.push", "    if (false) problems.push"],
  ["review manifest validation bypassed", RS, "    if (!match || new Set(declared).size !== declared.length) problems.push(\"invalid lane manifest\");", "    if (false) problems.push(\"invalid lane manifest\");"],
  ["review runner inherits parent environment", RR, "const env = codexEnvironment(home);", "const env = { ...process.env, ...codexEnvironment(home) };"],
  ["review runner accepts dirty source", RR, "  if (git(repo, ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all'])) throw Error('repo has uncommitted changes');", ""],
  ["review runner exposes builder response", RR, "if (name.endsWith('-response.md')) unlinkSync", "if (false) unlinkSync"],
  ["review runner loses lane failure", RR, "`lane ${l} exit ${code}\\n`", "`lane ${l} exit 0\\n`"],
  ["review runner gives writable sandbox", RR, "'--sandbox', 'read-only'", "'--sandbox', 'workspace-write'"],
  ["review runner loses evidence failure", RR, "}exit ${code}\\n`", "}exit 0\\n`"],
  ["review runner refreshes source index", RR, "['--no-optional-locks', 'status'", "['status'"],
  ["review runner parses prompt as flags", RR, "), '--', texts[l]]", "), texts[l]]"],
  ["review runner overwrites lane reservation", RR, "`lanes ${lanes.join(',')}\\n`, { flag: 'wx', mode: 0o600 }", "`lanes ${lanes.join(',')}\\n`, { flag: 'w', mode: 0o600 }"],
  ["review runner hides setup failure", RR, "    appendFileSync(join(roundDir, 'status'), 'runner-error\\n');", ""],
  ["desktop receipt skipped", DE, "if (!result.sessionStart) result.problems.push('Jarvis SessionStart receipt missing');", ""],
  ["desktop tripwire skipped", DE, "if (!result.tripwire) result.problems.push('linked Jarvis tripwire denial missing');", ""],
  ["desktop exact command ignored", DE, "record(block.input).command === expected.probeCommand", "true"],
  ["desktop tool linkage ignored", DE, "calls.has(block.tool_use_id)", "true"],
  ["desktop hook identity ignored", DE, "hook.command === `node \"${expected.pluginDir}/hooks/session-start.mjs\"`", "true"],
  ["desktop stale records accepted", DE, "Date.parse(e.timestamp) < start", "false"],
  ["desktop CLI canary skipped", DE, "if (!probe.ok) throw new Error('live canary failed; compatibility session was not started');", ""],
  ["desktop plugin hashes ignored", DK, "JSON.stringify(hashes(run.pluginDir)) !== JSON.stringify(run.pluginHashes)", "false"],
  ["desktop process outcome ignored", DK, "probe.ok !== true || outcome.code !== 0 || outcome.timedOut !== false || outcome.overflowed !== false", "false"],
  ["desktop terminal provenance accepted", DE, "if (relevant.some(e => e.entrypoint !== 'sdk-cli')) return fail('desktop SDK entrypoint missing');", ""],
  ["desktop attribution ignored", DE, "block.content.includes(`This hook comes from the jarvis@${format === 'cli' ? 'inline' : 'jarvis'} plugin.`)", "true"],
  ["desktop manifest changes ignored", DK, "'hooks/hooks.json', '.claude-plugin/plugin.json'", "'hooks/hooks.json'"],
  ["desktop symlink ancestors followed", DK, "if (existsSync(parent) && realpathSync(parent) !== parent) throw new Error('run ancestors must not use symlinks');", ""],
  // Codex stage 0 review 16, lane D.
  ["sandbox wrapper sees the runner environment", SR, '  const env = { PATH: r.env.PATH ?? "/usr/bin:/bin", HOME: homedir(),', '  const env = { ...process.env, PATH: r.env.PATH ?? "/usr/bin:/bin", HOME: homedir(),'],
  ["run TMPDIR not given to the sandbox", SR, "...(r.env.TMPDIR ? { CLAUDE_CODE_TMPDIR: r.env.TMPDIR } : {})", "...{}"],
  ["shared temp folder writable", SR, "denyWrite: SHARED_TMP", "denyWrite: []"],
  ["session output cap off", X, "        if (captured > spec.maxOutputBytes! && !overflowed) {", "        if (false) {"],
  ["gate ignores the case output cap", GT, "        maxOutputBytes: MAX_OUT_BYTES - captured,\n", ""],
  ["gate verifies over-cap observations", GT, "    if (withinCap) {\n      for (const k of g.check.cases) {", "    if (true) {\n      for (const k of g.check.cases) {"],
  ["filtered mutation runs claim complete coverage", "scripts/mutation-classify.mjs", "  const partial = filtered || selected !== total;", "  const partial = false;"],
  ["partial mutation runs pass as the gate", "scripts/mutation-classify.mjs", "  const exitCode = partial ? 4 : 0;", "  const exitCode = 0;"],
  // Review 16 lane D, Codex (docs/reviews/review16-d-mutations.json).
  ["public path replacement", "packages/cli/src/broker/server.ts", "    linkSync(privatePath, socketPath);", "    rmSync(socketPath, {force:true}); linkSync(privatePath, socketPath);"],
  ["close removes replacement", "packages/cli/src/broker/server.ts", "if (current?.dev === owned.dev && current.ino === owned.ino)", "if (current)"],
  ["project omitted from address", "packages/cli/src/broker/server.ts", "JSON.stringify([project, run])", "JSON.stringify([run])"],
  ["run omitted from address", "packages/cli/src/broker/server.ts", "JSON.stringify([project, run])", "JSON.stringify([project])"],
  ["foreground broker skips SIGINT cleanup", "packages/cli/src/cli.ts", "    process.once(\"SIGINT\", shutdown);", ""],
  ["act omits explicit run socket requirement", "packages/cli/src/cli.ts", "    if (!opts.socket) throw new Error(\"Specify a run socket with --socket or JARVIS_BROKER_SOCKET; use the path printed by jarvis broker.\");", ""],
  ["foreground broker skips SIGHUP cleanup", "packages/cli/src/cli.ts", "    process.once(\"SIGHUP\", shutdown);", ""],
  ["D5 bounded names removed", L, "      const marker = depth === 0\n        ? legacy\n        : join(this.dir, `${LOCK}.reclaim.${rootNonce}.${digest}`);", "      const marker = legacy;"],
  ["M1 legacy creation name depends on existence", L, "      if (depth > 0 && legacyFits && existsSync(legacy)) {\n        this.opts.onLockStep?.(\"legacy-observed\");\n        const previous = readOwner(legacy);\n        if (previous && !pidAlive(previous.pid)) {\n          path = legacy;\n          h = previous;\n          depth++;\n          continue;\n        }\n        sleepMs(2 + Math.floor(Math.random() * 5));\n        return;\n      }\n      const marker = depth === 0\n        ? legacy\n        : join(this.dir, `${LOCK}.reclaim.${rootNonce}.${digest}`);\n", "      const marker = legacyFits && (depth === 0 || existsSync(legacy))\n        ? legacy\n        : join(this.dir, `${LOCK}.reclaim.${rootNonce}.${digest}`);\n      if (depth > 0 && marker === legacy) this.opts.onLockStep?.(\"legacy-observed\");\n"],
  ["D4 conflicting answer throw to silent return", BR, "if (firstDecision !== decision) throw new Error(`already answered: ${firstDecision}`);", "if (firstDecision !== decision) return;"],
  ["D4 first linked answer find to findLast", BR, "const firstAnswer = open && es.find((e) => {", "const firstAnswer = open && es.findLast((e) => {"],
  ["D4 linked answer payload hash predicate removed", BR, "return d.approvalId === openData?.approvalId && d.payloadHash === hash && d.op === op", "return d.approvalId === openData?.approvalId && d.op === op"],
  ["D8 hook exact-key validation bypassed", "packages/cli/src/doctor/foundation.ts", "const keys = Object.keys(entry).sort();\n          return keys.join(\"\\0\") === [\"command\", \"type\"].join(\"\\0\")\n            && entry.type === \"command\" && entry.command === command;", "return entry.type === \"command\" && entry.command === command;"],
  ["D8 old truthy registration check", "packages/cli/src/doctor/foundation.ts", "const ok = registrationsMatch(\"PreToolUse\", 'node \"${CLAUDE_PLUGIN_ROOT}/hooks/tripwire.mjs\"', \"Bash|Read|Edit|Write|Glob|Grep\")\n      && registrationsMatch(\"SessionStart\", 'node \"${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs\"')\n      && existsSync(join(d.pluginDir, \"hooks\", \"tripwire.mjs\"))\n      && existsSync(join(d.pluginDir, \"hooks\", \"session-start.mjs\"))\n      && manifest.name === \"jarvis\"\n      && typeof manifest.version === \"string\" && manifest.version.length > 0;", "const ok = !!hooks.hooks?.PreToolUse && existsSync(join(d.pluginDir, \"hooks\", \"tripwire.mjs\")) && existsSync(join(d.pluginDir, \".claude-plugin\", \"plugin.json\"));"],
  ["D8 SessionStart matcher strictness bypassed", "packages/cli/src/doctor/foundation.ts", "const expectedRegistrationKeys = (matcher === undefined ? [\"hooks\"] : [\"hooks\", \"matcher\"]).sort();\n        if (registrationKeys.join(\"\\0\") !== expectedRegistrationKeys.join(\"\\0\")) return false;\n        if (candidate.matcher !== matcher) return false;", "const onlyHooks = registrationKeys.join(\"\\0\") === \"hooks\";\n        const hooksAndMatcher = registrationKeys.join(\"\\0\") === \"hooks\\0matcher\";\n        if (!onlyHooks && !hooksAndMatcher) return false;\n        if (matcher !== undefined && candidate.matcher !== matcher) return false;"],
  ["npm tokens not recognized", N, '  ["npm token", /\\bnpm_[A-Za-z0-9]{36}\\b/],', '  ["npm token", /(?!)/],'],
  ["INI text after a closing quote dropped", N, "/^([\"'])([\\s\\S]*?)\\1(\\s+[#;].*)?$/", "/^([\"'])([\\s\\S]*?)\\1/"],
  ["empty broker socket accepted", "packages/cli/src/cli.ts", '    if (socket === "") throw', '    if (false) throw'],
  ["SessionStart receipt missing", "plugin/hooks/session-start.mjs", 'if (path === undefined) process.stdout.write("Jarvis plugin: SessionStart ran (no run header).\\n");\nelse ', ""],
  ["outbox files can collide", "packages/cli/src/broker/outbox.ts", '-${op}-${randomUUID()}.json`);\n    writeFileSync(file, `${JSON.stringify({ op, payload }, null, 2)}\\n`, { mode: 0o600, flag: "wx" });', '-${op}.json`);\n    writeFileSync(file, `${JSON.stringify({ op, payload }, null, 2)}\\n`, { mode: 0o600 });'],
  ["session kills only the parent", X, "      process.kill(-child.pid, sig);", "      child.kill(sig);"],
  ["session hides spawn failures", X, "  if (spawnError) {", "  if (false) {"],
  ["scheduler counts unstarted runs", C, "        if (!r.started) {", "        if (false) {"],
  ["scheduler waits right after each run (old bug)", C, "        if (r.usageWaitUntil !== undefined && dispatched < total) pendingWait = { until: r.usageWaitUntil, after: id };", "        if (r.usageWaitUntil !== undefined) { const stop = await wait(id, r.usageWaitUntil, \"usage is high\"); if (stop) return { completed, stopped: { task: id, reason: stop } }; }"],
  ["password-only URLs ignored", N, ':\\/\\/)([^\\s/:@"<>`]*):', ':\\/\\/)([^\\s/:@"<>`]+):'],
  ["apostrophes end the password", N, ':([^\\s/@"<>`]+)@([^\\s/:', ":([^\\s/@'\"<>`]+)@([^\\s/:"],
  ["PEM rule needs a long body", N, '  ["private key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/],', '  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----\\s*[A-Za-z0-9+/=\\s]{100,}-----END/],'],
  ["session waits for pipes, not the leader's exit", X, '    child.on("exit", (c) => resolve(c));', '    child.on("close", (c) => resolve(c));'],
  ["session skips group cleanup", X, "  await cleanupGroup();\n", ""],
  ["session waits forever on pipes held outside its group", X, "    for (const sink of sinkStreams) sink.end();\n", ""],
  ["ledger ignores the chain", L, '    if (e.prev_hash !== prev) problems.push', '    if (false) problems.push'],
  ["ledger ignores edited entries", L, '    if (entryHash(rest) !== hash) problems.push', '    if (false) problems.push'],
  ["ledger ignores the head", L, '    else problems.push("head.hash does not match', '    else if (false) problems.push("head.hash does not match'],
  ["checks lock not tied to the ledger", K, "    if (!approved || (approved.data", "    if (false && (approved.data"],
  ["gate skips check verification", GT, "  if (!v.ok) return { status: \"tampered\"", "  if (false) return { status: \"tampered\""],
  ["gate runs checks unsandboxed", SR, "  const wrapped = await wrap(r);", "  const wrapped = r.command;"],
  ["gate lets checks read the runner folder", GT, "          denyRead: [real(g.jarvisHome), real(homedir()), real(verifyDir)],", "          denyRead: [real(homedir()), real(verifyDir)],"],
  ["candidate can read the verify folder", GT, "          denyRead: [real(g.jarvisHome), real(homedir()), real(verifyDir)],", "          denyRead: [real(g.jarvisHome), real(homedir())],"],
  ["candidate can read the expectations", GT, "          allowRead: [real(runDir), ...(hasFixtures ? [real(fixtures)] : [])],", "          allowRead: [real(runDir), real(g.store.checksDir)],"],
  ["verify phase can read the checkout", GT, "        denyRead: [real(g.jarvisHome), real(homedir()), real(runDir)],", "        denyRead: [real(g.jarvisHome), real(homedir())],"],
  ["gate ignores the completion line", GT, "allFinished && withinCap && verifyOk && complete ?", "allFinished && withinCap && verifyOk ?"],
  ["gate ignores case timeouts", GT, "allFinished && withinCap && verifyOk && complete ?", "withinCap && verifyOk && complete ?"],
  ["doctor skips a missing approved lock", "packages/cli/src/doctor/foundation.ts", "    if (v.ok && (approved || existsSync(store.lockPath))) {", "    if (v.ok && existsSync(store.lockPath)) {"],
  ["gate runs the worktree, not the revision", GT, "        cwd: real(checkout),\n", "        cwd: real(g.repoPath),\n"],
  ["gate clones without hash verification", GT, '"-c", "transfer.fsckObjects=true", "clone", "--quiet", "--no-local", "--no-checkout"', '"clone", "--quiet", "--no-hardlinks", "--no-checkout"'],
  ["gate records a signal as exit 0", GT, 'r.code === null ? "signal\\n"', 'r.code === null ? "0\\n"'],
  ["ledger ignores short writes", L, "    if (!Number.isInteger(n) || n <= 0) throw new Error", "    if (false) throw new Error"],
  ["lock reclaimed without a marker", L, "      if (!existsSync(marker) && this.createOwned(marker, mine)) {", "      if (true) {"],
  ["a dead reclaimer's marker blocks forever", L, "      if (m && !pidAlive(m.pid)) {", "      if (false) {"],
  ["evidence not re-hashed", GT, "    else if (sha(p) !== h) problems.push", "    else if (false) problems.push"],
  ["D4 operation-only approval binding (prior shared control)", BR, "        const open = es.find((e) => e.kind === \"approval_request\" && (e.data as D).payloadHash === hash && (e.data as D).op === op);\n        const openData = open?.data as D | undefined;\n        const firstAnswer = open && es.find((e) => {\n          if (e.kind !== \"approval\") return false;\n          const d = e.data as D;\n          return d.approvalId === openData?.approvalId && d.payloadHash === hash && d.op === op\n            && (d.decision === \"approve\" || d.decision === \"reject\");\n        });", "        const open = es.find((e) => e.kind === \"approval_request\" && (e.data as D).op === op);\n        const openData = open?.data as D | undefined;\n        const firstAnswer = open && es.find((e) => {\n          if (e.kind !== \"approval\") return false;\n          const d = e.data as D;\n          return d.approvalId === openData?.approvalId && d.op === op\n            && (d.decision === \"approve\" || d.decision === \"reject\");\n        });"],
  ["broker retries unknown outcomes", BR, '["succeeded", "unknown"].includes', '["succeeded"].includes'],
  ["broker skips the executing intent", BR, '    const intent = add({ kind: "broker_request", actor: "broker", data: executingIntent(hash, approvalId, op, process.pid, this.instance) });', "    const intent = { seq: 0 };"],
  ["broker starts a second execution while one runs", BR, "    if (running) return answer(", "    if (false) return answer("],
  ["reconcile settles live executions", BR, '        if (typeof d.pid === "number" && pidAlive(d.pid)) continue;\n', ""],
  ["broker treats adapter crashes as failures", BR, '        result = { outcome: "unknown", detail: { reason: `adapter error', '        result = { outcome: "failed", detail: { reason: `adapter error'],
  ["broker auto-allows everything", BR, "    if (!spec.autoAllow) {", "    if (false) {"],
  ["broker ignores ledger tampering", BR, '      if (err instanceof LedgerTamperError) return { status: "error"', '      if (err instanceof LedgerTamperError) return { status: "succeeded"'],
  ["tripwire lets file tools write runner-home notes", TW, "SESSION_OWNED.test(path) && !RUNNER_HOME.test(path) && ", "SESSION_OWNED.test(path) && "],
  ["tripwire lets file tools climb out with ..", TW, " && !/(^|\\/)\\.\\.(\\/|$)/.test(path)", ""],
  ["tripwire misses publishing", TW, '  [/\\b(npm|pnpm|yarn)\\s+publish\\b/, "publishing packages is a hard stop"],\n', ""],
  ["read-only dirs writable", S, "          ...(input.readOnlyDirs ?? []),\n        ],", "        ],"],
  ["scheduler skips limited tasks", C, "          continue; // the same task again; waiting is not a failure", "          break;"],
];
// Lane-owned definitions live next to their code (decision 81: mutations arrive as definitions).
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Each entry's fifth element is where it was defined, which sets its stage (decision 94).
for (const m of mutations) m.push("inline");
for (const file of globSync(DEFINITION_GLOBS, { cwd: root }).sort()) {
  for (const m of JSON.parse(readFileSync(join(root, file), "utf8"))) mutations.push([m.name, m.file, m.anchor, m.replacement, file]);
}
const names = mutations.map(([n]) => n);
const duplicate = names.find((n, i) => names.indexOf(n) !== i);
if (duplicate) { console.log(`duplicate mutation name: ${duplicate}`); process.exit(2); }
// Concurrent suites caused timing failures (decision 81, rule 3), so one job is the default. More jobs
// split the workers one full-suite run would use and are capped by them (mutation-run.mjs, jobPlan).
const requested = Number(process.env.JARVIS_MUTATION_JOBS ?? "1");
if (!Number.isInteger(requested) || requested < 1) { console.log(`JARVIS_MUTATION_JOBS must be a whole number of at least 1, not "${process.env.JARVIS_MUTATION_JOBS}"`); process.exit(2); }
const { jobs, flags: workerFlags } = jobPlan(requested, availableParallelism());
let mode;
try {
  mode = parseMode(process.argv.slice(2), process.env);
} catch (err) {
  console.log(err.message);
  process.exit(2);
}
const modeLabel = mode.mode === "confirm" ? "confirm mode" : mode.mode === "stage" ? `stage ${mode.stage} confirmed, the rest in fast mode` : "fast mode (catches on related tests only)";
const started = Date.now();

// Mutations run in disposable clones of the committed revision, never in the working tree, so an
// interruption can't leave a safeguard disabled in the code under review (Codex stage 0 review 5).
// One clone per job, so a job's mutated file is never seen by another job's run.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = realpathSync(mkdtempSync(join(tmpdir(), "jarvis-mut-")));
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };
const clones = Array.from({ length: jobs }, (_, i) => join(work, i === 0 ? "repo" : `repo-${i + 1}`));
for (const [i, clone] of clones.entries()) {
  // Later clones copy the first, so every job tests the same revision.
  execFileSync("git", ["clone", "--quiet", "--no-hardlinks", i === 0 ? repo : clones[0], clone], { env: gitEnv });
  for (const nm of ["node_modules", "packages/cli/node_modules"]) symlinkSync(join(repo, nm), join(clone, nm));
}
const sandboxRepo = clones[0];
process.chdir(sandboxRepo);
console.log(`mutating a clone of ${execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: sandboxRepo, encoding: "utf8" }).trim()} (uncommitted changes are not included)`);
if (jobs < requested) console.log(`running ${jobs} jobs, not ${requested}: one full-suite run's worker budget is ${jobs}`);
// If the check is interrupted: stop every running suite's process group (TERM, then KILL), wait for
// them to end, then put back whatever files are mutated and remove the clones (Codex review, 2).
const current = new Map(); // clone -> [path, original]
let stopping = false;
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    await stopAll();
    for (const [path, original] of current.values()) writeFileSync(path, original);
    rmSync(work, { recursive: true, force: true });
    process.exit(130);
  });
}
/**
 * Stops processes a run left behind: a mutation that breaks process cleanup leaves the tests'
 * SIGTERM-resistant descendants running. Only processes whose command line names this run's own
 * temp folder are stopped (no broad patterns).
 */
function reapLeftovers(tmp) {
  const ps = spawnSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  for (const line of (ps.stdout ?? "").split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m || Number(m[1]) === process.pid || !m[2].includes(tmp)) continue;
    try {
      process.kill(Number(m[1]), "SIGKILL");
    } catch {
      // already gone
    }
  }
}

let runs = 0;
/** Runs `files` (default: all of tests/unit) in `clone` as one process group, with spawnSync's old limits. */
async function runSuite(clone, tag, files) {
  if (stopping) throw new Error("stopped by a signal");
  const id = `${++runs}-${tag}`;
  // Short, per run: Unix socket paths in the tests must stay under macOS's 104-byte limit.
  const tmp = realpathSync(mkdtempSync("/tmp/jmt-"));
  try {
    // Vitest directly: pnpm's dependency check rejects the clone's symlinked node_modules.
    return await runAndRead(
      join(clone, "node_modules", ".bin", "vitest"),
      // Anchor-applicability tests (*-mutations.test.ts) fail on every mutation by design, so they never count as catching one.
      ["run", ...(files ?? ["tests/unit"]), "--exclude", "**/*-mutations.test.ts", "--reporter=json", `--outputFile=${join(work, `${id}.json`)}`, "--reporter=./scripts/unhandled-reporter.mjs", ...workerFlags],
      { cwd: clone, env: { ...process.env, JARVIS_RUN_END_OUT: join(work, `${id}.end.json`), JARVIS_TEST_TMP: tmp } },
      { report: join(work, `${id}.json`), end: join(work, `${id}.end.json`) },
    );
  } finally {
    reapLeftovers(tmp);
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Vitest's own import-graph answer for each file, from its module graph (no test runs). In a child
 * process, so nothing Vitest sets up leaks into this process or the suites it starts.
 */
function vitestRelated(files) {
  const code = `
    import { relative } from "node:path";
    import { createVitest } from "vitest/node";
    const [root, files] = [process.argv[1], JSON.parse(process.argv[2])];
    const related = {};
    for (const file of files) {
      const v = await createVitest("test", { root, watch: false, run: true, related: [root + "/" + file] });
      try {
        related[file] = (await v.getRelevantTestSpecifications(["tests/unit"])).map((s) => relative(root, s.moduleId));
      } finally {
        await v.close();
      }
    }
    process.stdout.write(JSON.stringify(related));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code, sandboxRepo, JSON.stringify(files)], { cwd: sandboxRepo, encoding: "utf8", timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`exit ${r.status ?? r.signal}: ${(r.stderr ?? "").trim().split("\n").slice(-3).join(" ")}`);
  return new Map(Object.entries(JSON.parse(r.stdout)));
}

const minutes = (ms) => `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
// JARVIS_MUTATIONS=<regex> runs only the matching mutations (for iterating; evidence runs use all).
const only = process.env.JARVIS_MUTATIONS ? new RegExp(process.env.JARVIS_MUTATIONS) : undefined;
const selected = mutations.filter(([n]) => !only || only.test(n));

/** The whole check after setup; resolves with the exit code. Every job has ended when it settles. */
async function main() {
  const controls = [];
  const verdicts = [];
  // Fast mode: which test files can observe each mutated file (the reference graph, plus Vitest's own).
  const testsFor = new Map();
  if (mode.mode !== "confirm") {
    const tracked = execFileSync("git", ["-c", "core.fsmonitor=false", "ls-files", "-z"], { cwd: sandboxRepo, encoding: "utf8", env: gitEnv }).split("\0").filter(Boolean);
    const graph = buildGraph(tracked, (p) => {
      try {
        return readFileSync(join(sandboxRepo, p), "utf8");
      } catch {
        return undefined;
      }
    });
    const candidates = tracked.filter(isCandidateTest);
    let fromVitest;
    try {
      fromVitest = vitestRelated([...new Set(selected.map(([, file]) => file))]);
    } catch (err) {
      console.log(`could not read Vitest's module graph: ${err?.message ?? err}`);
      return 2;
    }
    for (const [f, extra] of fromVitest) testsFor.set(f, relatedTests(f, graph, candidates, extra));
  }

  const control = await runSuite(sandboxRepo, "control");
  const c = classify(control.proc, control.report, undefined, control.runEnd);
  if (c.kind !== "clean" || control.proc.status !== 0) {
    console.log(`control run is not clean: ${c.kind}: ${c.detail}`);
    return 2;
  }
  const controlIds = testIds(control.report);
  controls.push(`control  ${c.detail} [full suite, ${collectedFiles(control.report, sandboxRepo).length} test files]`);
  const subsetControl = subsetControls({ run: (files, clone) => runSuite(clone, "control-subset", files), controlIds, onLine: (line) => controls.push(line) });

  const mutate = async (clone, [name, file, from, to, source]) => {
    const path = join(clone, file);
    const orig = readFileSync(path, "utf8");
    if (!orig.includes(from)) return `ERROR    ${name}: anchor not found in ${file}`;
    const tests = testsFor.get(file) ?? [];
    const confirm = confirmFor(mode, source);
    // The subset's control runs before this clone is mutated, so a control only ever sees unmutated code.
    const ctl = tests.length && !confirm ? await subsetControl(tests, clone) : undefined;
    const tag = name.replace(/\W+/g, "-");
    try {
      current.set(clone, [path, orig]);
      writeFileSync(path, orig.replace(from, to));
      const k = await judge({
        tests,
        confirm,
        control: () => ctl,
        runSubset: async (t, sc) => {
          const m = await runSuite(clone, tag, t);
          return classify(m.proc, m.report, sc.ids, m.runEnd);
        },
        runFull: async () => {
          const m = await runSuite(clone, `${tag}-full`);
          return classify(m.proc, m.report, controlIds, m.runEnd);
        },
      });
      verdicts.push({ kind: k.kind, confirmed: k.confirmed, scoped: confirm });
      return `${k.kind === "caught" ? "caught  " : k.kind === "survived" ? "SURVIVED" : "ERROR   "} ${name} (${k.detail}) [${k.scope}]`;
    } finally {
      writeFileSync(path, orig);
      current.delete(clone);
    }
  };
  let finished = 0;
  let results;
  try {
    // A failed job stops the others' suites; the pool settles only after every job has ended.
    results = await runPool(selected, clones, async (clone, m) => {
      const line = await mutate(clone, m);
      console.error(`[${++finished}/${selected.length}, ${minutes(Date.now() - started)}] ${line}`);
      return line;
    }, { onError: () => stopAll(), stopped: () => stopping });
  } catch (err) {
    console.log(`mutation check stopped: ${err?.message ?? err}`);
    return 2;
  }
  console.log([...controls, ...results].join("\n"));
  console.log(`\nwall time ${minutes(Date.now() - started)} for ${selected.length} mutation(s), ${jobs} job(s), ${modeLabel}`);
  const t = tally(verdicts, mode);
  const scope = mode.mode === "stage" ? { stage: mode.stage, confirmed: t.confirmed, fast: t.fast } : undefined;
  const s = summarize({ total: mutations.length, selected: selected.length, filtered: only !== undefined, results, unconfirmed: t.unconfirmed, scope });
  console.log(`\n${s.line}`);
  return s.exitCode;
}

// While a signal is being handled, its handler owns cleanup and the exit code.
main().then(
  (code) => {
    if (stopping) return;
    rmSync(work, { recursive: true, force: true });
    process.exitCode = code;
  },
  (err) => {
    if (stopping) return;
    rmSync(work, { recursive: true, force: true });
    console.log(`mutation check failed: ${err?.stack ?? err}`);
    process.exitCode = 2;
  },
);
