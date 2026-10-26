// A worker thread for the credential-encodings tests (snapshot-2 and snapshot-3, through snapshotErrors in
// helpers/snapshot-fixture.ts): createSnapshot and git run synchronously, so only separate threads let the cases
// run side by side. It takes one message per case, { name, content }, builds the case's repository, snapshots it
// and posts the refusal (or "" if the snapshot succeeded). The tests keep every case and every assertion; this
// file only runs them.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { createSnapshot } from "../../packages/cli/src/eval/snapshot.ts";
import { useRealGit } from "../setup/use-real-git.ts";
import { copyRepoTemplate } from "./helpers/git-template.ts";

const { root, template, realGit } = workerData;
useRealGit(realGit); // a worker thread has its own child_process: skip the /usr/bin/git shim here too
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();

parentPort.on("message", async ({ name, content }) => {
  const slug = name.replaceAll("/", "_");
  const repo = join(root, `srcE-${slug}`);
  mkdirSync(dirname(join(repo, name)), { recursive: true });
  copyRepoTemplate(template, repo); // what `git init -q -b main` and the two `git config user.*` calls leave
  writeFileSync(join(repo, name), name === "utf16.json" ? Buffer.from(content, "latin1") : content);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "c");
  const err = await createSnapshot({ sourceRepo: repo, rev: "HEAD", dest: join(root, `snapE-${slug}`) }).then(() => "", (e) => e.message);
  parentPort.postMessage(err);
});
