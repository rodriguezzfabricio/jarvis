// One case of the credential-encodings test (snapshot-2 and snapshot-3), in a worker thread: createSnapshot and git
// run synchronously, so only separate threads let the cases run side by side. The test keeps every
// case and every assertion; this file only builds the case's repository and returns the refusal.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { createSnapshot } from "../../packages/cli/src/eval/snapshot.ts";

const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
const { root, name, content } = workerData;
const slug = name.replaceAll("/", "_");
const repo = join(root, `srcE-${slug}`);
mkdirSync(dirname(join(repo, name)), { recursive: true });
git(repo, "init", "-q", "-b", "main");
git(repo, "config", "user.email", "t@t");
git(repo, "config", "user.name", "t");
writeFileSync(join(repo, name), name === "utf16.json" ? Buffer.from(content, "latin1") : content);
git(repo, "add", "-A");
git(repo, "commit", "-qm", "c");
const err = await createSnapshot({ sourceRepo: repo, rev: "HEAD", dest: join(root, `snapE-${slug}`) }).then(() => "", (e) => e.message);
parentPort.postMessage(err);
