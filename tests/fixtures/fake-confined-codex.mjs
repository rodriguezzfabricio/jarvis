// A fake Codex for the confined reviewer (decision 110). Tests copy it, behind a node shebang, to
// <tools>/fake-codex beside a config.json. It records its argv and environment, and on `exec` probes
// what its confinement lets it reach: each probe's outcome is recorded, never assumed.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';

const cfg = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const argv = process.argv.slice(2);
const record = (entry) => appendFileSync(cfg.record, JSON.stringify(entry) + '\n');
if (argv.includes('--version')) {
  record({ argv, env: process.env });
  console.log(cfg.version ?? 'codex-cli 0.164.0');
  process.exit(0);
}
const read = (path) => { try { return `read:${readFileSync(path, 'utf8')}`; } catch (e) { return `denied:${e.code}`; } };
const write = (path) => { try { writeFileSync(path, 'reviewer was here'); return 'written'; } catch (e) { return `denied:${e.code}`; } };
const tcp = (port) => new Promise((resolve) => {
  const s = connect(port, '127.0.0.1');
  s.once('connect', () => { s.destroy(); resolve('connected'); });
  s.once('error', (e) => resolve(`error:${e.code}`));
});
const tunnel = (host) => new Promise((resolve) => {
  const proxy = new URL(process.env.HTTPS_PROXY);
  const s = connect(Number(proxy.port), proxy.hostname);
  let reply = '';
  s.once('connect', () => s.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`));
  s.on('data', (d) => { reply += d; if (reply.includes('\r\n')) { s.destroy(); resolve(reply.split('\r\n')[0]); } });
  s.once('error', (e) => resolve(`error:${e.code}`));
});
const probes = cfg.probes ?? {};
const seen = {};
// "$CODEX_HOME/..." names a file in whatever Codex home the runner handed this process.
const expand = (path) => path.replace(/^\$CODEX_HOME(?=\/)/, process.env.CODEX_HOME);
for (const [name, path] of Object.entries(probes.read ?? {})) seen[`read ${name}`] = read(expand(path));
for (const [name, path] of Object.entries(probes.write ?? {})) seen[`write ${name}`] = write(expand(path));
if (probes.tcpPort) seen.tcp = await tcp(probes.tcpPort);
for (const host of probes.tunnel ?? []) seen[`tunnel ${host}`] = await tunnel(host);
record({ argv, env: process.env, seen });
const output = argv[argv.indexOf('-o') + 1];
writeFileSync(output, JSON.stringify({ findings: [] }));
console.log(JSON.stringify({ type: 'turn.completed' }));
