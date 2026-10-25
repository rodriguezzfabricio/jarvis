// A fake Codex lane for scripts/review-run.mjs. It runs inside the reviewer's Seatbelt profile
// (decision 110), so it writes only in its verdict's folder (the jail's shared output folder) and reports
// its environment on stderr, which the runner captures in the round folder.
// The prompt is the lane's text: "FAIL" exits 7, "wait:A,B,D" waits until those lanes have started,
// "LINK" plants a symlink where the verdict belongs, "PROBE:<path>|<path>" reports whether each path reads.
import { fstatSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
const argv = process.argv.slice(2);
const output = argv[argv.indexOf('-o') + 1];
const dir = dirname(output);
const id = /verdict-([A-D])/.exec(output)[1];
const prompt = argv.at(-1);
const started = Date.now();
const env = { ...process.env };
const stdinCharacterDevice = fstatSync(0).isCharacterDevice();
if (readFileSync(0).length !== 0) throw Error('stdin not EOF');
writeFileSync(join(dir, `started-${id}`), 'yes');
const wait = /wait:([A-D,]+)/.exec(prompt)?.[1].split(',') ?? [];
const deadline = Date.now() + 8000;
while (!wait.every(l => existsSync(join(dir, `started-${l}`)))) {
  if (Date.now() > deadline) process.exit(9);
  await new Promise(r => setTimeout(r, 10));
}
await new Promise(r => setTimeout(r, 20));
if (prompt === 'LINK') symlinkSync(argv[argv.indexOf('--output-schema') + 1], output);
else writeFileSync(output, JSON.stringify({ verdict: 'PASS', summary: 'synthetic', findings: [], remaining_for_stage0: [] }));
const probe = (path) => { try { return `read:${readFileSync(path, 'utf8')}`; } catch (e) { return `denied:${e.code}`; } };
const seen = prompt.startsWith('PROBE:') ? prompt.slice(6).split('|').map(probe) : [];
process.stderr.write(JSON.stringify({ env, argv, stdinCharacterDevice, started, finished: Date.now(), seen }) + '\n');
process.exitCode = prompt === 'FAIL' ? 7 : 0;
