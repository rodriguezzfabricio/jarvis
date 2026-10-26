// Run in a fresh Node process so comparisons start with untouched builtins.
import cp, { execFileSync, spawnSync, spawn, execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { useRealGit } from '../../setup/use-real-git.ts';

const [api, root] = process.argv.slice(2);
const originals = { execFileSync, spawnSync, spawn, execFile };
const custom = execFile[promisify.custom];
const promised = promisify(execFile);
const env = { PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const replacement = join(root, 'replacement');
writeFileSync(replacement, '#!/bin/sh\necho WRONG-EXECUTABLE\n', { mode: 0o755 });
useRealGit(replacement, { CPATH: '/wrong/include', LIBRARY_PATH: '/wrong/lib', MANPATH: '/wrong/man' });
const identities = Object.fromEntries(Object.keys(originals).map(key => [key, cp[key] === originals[key]]));
identities.promisified = cp.execFile[promisify.custom] === custom;

async function run(native, file, args, options) {
  const funcs = native ? originals : cp;
  if (api === 'execFileSync') return funcs.execFileSync(file, args, options).toString();
  if (api === 'spawnSync') {
    const r = funcs.spawnSync(file, args, options);
    if (r.error) throw r.error;
    return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), status: r.status, signal: r.signal };
  }
  if (api === 'promisified') {
    const call = native ? promised : promisify(cp.execFile);
    return (await (options === undefined ? call(file, args) : call(file, args, options))).stdout.toString();
  }
  if (api === 'execFile') return await new Promise((resolve, reject) => {
    const callback = (error, stdout) => error ? reject(error) : resolve(stdout.toString());
    if (options === undefined) funcs.execFile(file, args, callback);
    else funcs.execFile(file, args, options, callback);
  });
  return await new Promise((resolve, reject) => {
    const child = funcs.spawn(file, args, options);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ stdout, stderr, status, signal, file: child.spawnfile, args: child.spawnargs }));
  });
}
mkdirSync(join(root, 'parent'));
process.chdir(join(root, 'parent'));
const cases = {};
async function compare(name, file, args, options) {
  const capture = async native => {
    try { return { value: await run(native, file, args, options) }; }
    catch (error) { return { error: { message: error.message, code: error.code, path: error.path, spawnargs: error.spawnargs, stderr: error.stderr?.toString() } }; }
  };
  cases[name] = { native: await capture(true), configured: await capture(false) };
}
function fake(dir, label) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'git'), `#!${process.execPath}\nconsole.log(JSON.stringify({label:${JSON.stringify(label)},args:process.argv.slice(2),cwd:process.cwd(),env:process.env}));\n`, { mode: 0o755 });
}
const bin = join(root, 'bin');
fake(bin, 'caller-git');
const args = ['space value', '', '$HOME', '`literal`', '--dash'];
await compare('absolute', join(bin, 'git'), args, { cwd: root, env });
await compare('first PATH executable', 'git', args, { cwd: root, env: { ...env, PATH: `${bin}:/usr/bin:/bin` } });
await compare('relative PATH', 'git', args, { cwd: root, env: { ...env, PATH: 'bin:/usr/bin:/bin' } });
fake(root, 'cwd-git');
await compare('empty PATH entry', 'git', args, { cwd: root, env: { ...env, PATH: ':/usr/bin:/bin' } });
const later = join(root, 'later');
mkdirSync(later);
const options = { cwd: root, env: { ...env, PATH: `${later}:/usr/bin:/bin` } };
await compare('before earlier executable', 'git', ['--version'], options);
fake(later, 'new-earlier-git');
await compare('new earlier executable', 'git', args, options);
await compare('missing PATH', 'git', ['--version'], { cwd: root, env: { HOME: root } });
await compare('no options', 'git', ['--version']);
await compare('shell', 'git', ['--version'], { cwd: root, env, shell: true });
await compare('absolute system git', '/usr/bin/git', ['--version'], { cwd: root, env });
for (const key of ['CPATH', 'LIBRARY_PATH', 'MANPATH', 'SDKROOT']) {
  await compare(key, 'git', ['-c', 'alias.e=!env', 'e'], { cwd: root, env: { ...env, [key]: '/callers/own' } });
}
await compare('failed git', 'git', ['--not-a-real-option'], { cwd: root, env });
process.stdout.write(JSON.stringify({ identities, cases }));
