import { fstatSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
const argv = process.argv.slice(2);
const output = argv[argv.indexOf('-o') + 1];
const dir = dirname(output);
const id = /verdict-([A-D])/.exec(output)[1];
const started = Date.now();
const env = { ...process.env };
const stdinCharacterDevice = fstatSync(0).isCharacterDevice();
if (readFileSync(0).length !== 0) throw Error('stdin not EOF');
writeFileSync(join(dir, `started-${id}`), 'yes');
const lanes = readFileSync(join(dir, 'lanes'), 'utf8').trim().slice(6).split(',');
const deadline = Date.now() + 4000;
while (!lanes.every(l => existsSync(join(dir, `started-${l}`)))) {
  if (Date.now() > deadline) process.exit(9);
  await new Promise(r => setTimeout(r, 10));
}
await new Promise(r => setTimeout(r, 20));
writeFileSync(output, JSON.stringify({ verdict: 'PASS', summary: 'synthetic', findings: [], remaining_for_stage0: [] }));
writeFileSync(join(dir, `env-${id}.json`), JSON.stringify({ env, argv, stdinCharacterDevice, started, finished: Date.now() }));
process.exitCode = argv.at(-1) === 'FAIL' ? 7 : 0;
