// Breaks each safeguard in turn and checks that the unit suite catches it with failing assertions.
// Evidence for "tests test what they claim" (AGENTS.md; Codex stage 0 reviews 1 and 2).
// A mutation counts as caught only if: the unmodified control run passed, the mutated run collected
// the same number of tests, and at least one assertion failed. Crashes and collection errors are
// errors, never "caught". Every file is restored, even on failure.
// Usage: node scripts/mutation-check.mjs   (JARVIS_MUTATIONS=<regex> to run a subset)
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classify, summarize, testIds } from "./mutation-classify.mjs";

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
  ["baseline shares one cache", B, 'const cacheRoot = join(workRoot, "cache-runs", task.id, runId);', 'const cacheRoot = join(workRoot, "cache-runs", "shared");'],
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
  ["fourth review lane ignored", RS, "[\"A\", \"B\", \"C\", \"D\"] : [\"single\"]", "[\"A\", \"B\", \"C\"] : [\"single\"]"],
  ["invalid verdict not reported", RS, "if (!valid) problems.push", "if (false) problems.push"],
  ["revision mismatch ignored", RS, "if (documented && inferred && documented !== inferred)", "if (false)"],
  ["missing completion marker ignored", RS, "if (exitCode === null) problems.push", "if (false) problems.push"],
  ["mixed help accepted", RS, "(help && args.length !== 1)", "false"],
  ["symlink entry point ignored", RS, "realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))", "resolve(process.argv[1]) === fileURLToPath(import.meta.url)"],
  ["FIFO open blocks", RS, "constants.O_RDONLY | constants.O_NONBLOCK", "\"r\""],
  // Codex stage 0 review 16, lane D.
  ["sandbox wrapper sees the runner environment", SR, '  const env = { PATH: r.env.PATH ?? "/usr/bin:/bin", HOME: homedir(),', '  const env = { ...process.env, PATH: r.env.PATH ?? "/usr/bin:/bin", HOME: homedir(),'],
  ["run TMPDIR not given to the sandbox", SR, "...(r.env.TMPDIR ? { CLAUDE_CODE_TMPDIR: r.env.TMPDIR } : {})", "...{}"],
  ["shared temp folder writable", SR, "denyWrite: SHARED_TMP", "denyWrite: []"],
  ["session output cap off", X, "        if (captured > spec.maxOutputBytes! && !overflowed) {", "        if (false) {"],
  ["gate ignores the case output cap", GT, "        maxOutputBytes: MAX_OUT_BYTES - captured,\n", ""],
  ["gate verifies over-cap observations", GT, "    if (withinCap) {\n      for (const k of g.check.cases) {", "    if (true) {\n      for (const k of g.check.cases) {"],
  ["filtered mutation runs claim complete coverage", "scripts/mutation-classify.mjs", "  if (filtered || selected !== total) return", "  if (false) return"],
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
  ["tripwire misses publishing", TW, '  [/\\b(npm|pnpm|yarn)\\s+publish\\b/, "publishing packages is a hard stop"],\n', ""],
  ["read-only dirs writable", S, "          ...(input.readOnlyDirs ?? []),\n        ],", "        ],"],
  ["scheduler skips limited tasks", C, "          continue; // the same task again; waiting is not a failure", "          break;"],
];

// Mutations run in a disposable clone of the committed revision, never in the working tree, so an
// interruption can't leave a safeguard disabled in the code under review (Codex stage 0 review 5).
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "jarvis-mut-"));
const sandboxRepo = join(work, "repo");
execFileSync("git", ["clone", "--quiet", "--no-hardlinks", repo, sandboxRepo], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
for (const nm of ["node_modules", "packages/cli/node_modules"]) symlinkSync(join(repo, nm), join(sandboxRepo, nm));
process.chdir(sandboxRepo);
console.log(`mutating a clone of ${execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: sandboxRepo, encoding: "utf8" }).trim()} (uncommitted changes are not included)`);
// If the check is interrupted, put back whatever file is currently mutated before exiting.
let current; // [file, original]
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    if (current) writeFileSync(current[0], current[1]);
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

function runSuite(tag) {
  const out = join(work, `${tag}.json`);
  // Short, per run: Unix socket paths in the tests must stay under macOS's 104-byte limit.
  const tmp = realpathSync(mkdtempSync("/tmp/jmt-"));
  // Vitest directly: pnpm's dependency check rejects the clone's symlinked node_modules.
  const end = join(work, `${tag}.end.json`);
  const proc = spawnSync(
    join(sandboxRepo, "node_modules", ".bin", "vitest"),
    ["run", "tests/unit", "--reporter=json", `--outputFile=${out}`, "--reporter=./scripts/unhandled-reporter.mjs"],
    { encoding: "utf8", timeout: 900_000, env: { ...process.env, JARVIS_RUN_END_OUT: end, JARVIS_TEST_TMP: tmp } },
  );
  reapLeftovers(tmp);
  rmSync(tmp, { recursive: true, force: true });
  const report = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : undefined;
  const runEnd = existsSync(end) ? JSON.parse(readFileSync(end, "utf8")) : undefined;
  return { proc, report, runEnd };
}

const results = [];
let controlIds;
// JARVIS_MUTATIONS=<regex> runs only the matching mutations (for iterating; evidence runs use all).
const only = process.env.JARVIS_MUTATIONS ? new RegExp(process.env.JARVIS_MUTATIONS) : undefined;
const selected = mutations.filter(([n]) => !only || only.test(n));
try {
  const control = runSuite("control");
  const c = classify(control.proc, control.report, undefined, control.runEnd);
  if (c.kind !== "clean" || control.proc.status !== 0) {
    console.log(`control run is not clean: ${c.kind}: ${c.detail}`);
    process.exit(2);
  }
  controlIds = testIds(control.report);
  results.push(`control  ${c.detail}`);
  for (const [name, file, from, to] of selected) {
    const orig = readFileSync(file, "utf8");
    if (!orig.includes(from)) { results.push(`ERROR    ${name}: anchor not found in ${file}`); continue; }
    try {
      current = [file, orig];
      writeFileSync(file, orig.replace(from, to));
      const m = runSuite(name.replace(/\W+/g, "-"));
      const k = classify(m.proc, m.report, controlIds, m.runEnd);
      results.push(`${k.kind === "caught" ? "caught  " : k.kind === "survived" ? "SURVIVED" : "ERROR   "} ${name} (${k.detail})`);
    } finally {
      writeFileSync(file, orig);
      current = undefined;
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(results.join("\n"));
const s = summarize({ total: mutations.length, selected: selected.length, filtered: only !== undefined, results: results.filter((l) => !l.startsWith("control")) });
console.log(`\n${s.line}`);
process.exitCode = s.exitCode;
