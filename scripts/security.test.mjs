import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { agentEnv, workspaceGuard, sandboxSpawn, terminateGroup } from '../server/security.mjs';
import { needsPermission } from '../server/pi/tools.mjs';

function fixture(t) {
  const root = mkdtempSync('/tmp/opencode/wb-security-');
  const home = path.join(root, 'home'); const dataDir = path.join(home, 'control');
  const general = path.join(dataDir, 'general');
  for (const dir of [general, `${home}/.config/secrets`, `${home}/.ssh`, `${home}/.aws`, `${home}/outside`, `${home}/.config/gh`, `${home}/.local/share/opencode`, `${home}/.docker`, `${home}/.kube`, `${home}/.config/systemd/user`, `${home}/.local/bin`, `${dataDir}/pi`]) mkdirSync(dir, { recursive: true });
  for (const file of ['.config/secrets/canary', '.ssh/canary', '.aws/canary', '.netrc', '.git-credentials', 'control/workbench.sqlite', '.config/gh/hosts.yml', '.local/share/opencode/mcp-auth.json', '.docker/config.json', '.kube/config', '.npmrc', '.pypirc']) writeFileSync(`${home}/${file}`, 'SECRET_CANARY');
  for (const file of ['.bashrc', '.profile']) writeFileSync(`${home}/${file}`, 'ORIGINAL');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, home, dataDir, general };
}

function collect(child) {
  return new Promise((resolve, reject) => {
    let stdout = ''; let stderr = '';
    child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('environment allowlist removes control/cloud/provider/shell injection secrets', () => {
  assert.deepEqual(agentEnv({ HOME: '/home/u', PATH: '/usr/bin', WORKBENCH_PROXY_KEY: 's', CLOUDFLARE_API_TOKEN: 's', OPENAI_API_KEY: 's', BASH_ENV: '/evil', NODE_OPTIONS: '--require=evil', AWS_SECRET_ACCESS_KEY: 's' }), { HOME: '/home/u', PATH: '/usr/bin' });
});

test('sandbox keeps DNS working without exposing /run/systemd/resolve', async t => {
  const f = fixture(t);
  // /etc/resolv.conf is typically a symlink into /run (systemd-resolved). The
  // sandbox must resolve it WITHOUT mounting that directory, whose world-
  // writable varlink sockets would otherwise leak into every run.
  const code = `const fs=require('node:fs');const dns=require('node:dns');
    const d=fs.readFileSync('/etc/resolv.conf','utf8');
    if(!/^nameserver/m.test(d))throw new Error('no nameserver');
    if(fs.existsSync('/run/systemd/resolve'))throw new Error('systemd-resolved directory leaked into sandbox');
    dns.lookup('example.com',(error,address)=>{if(error){console.error(error.message);process.exit(1);}console.log('dns-ok '+address);});`;
  const result = await collect(sandboxSpawn(process.execPath, ['-e', code], { ...f, workspace: f.general }, { stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /dns-ok/);
});

test('write guard rejects traversal and existing/nonexistent paths through symlinks', t => {
  const { home } = fixture(t);
  symlinkSync('/etc', `${home}/escape`);
  assert.equal(workspaceGuard(home, { toolName: 'write', input: { path: 'escape/new-file' } })?.block, true);
  assert.equal(workspaceGuard(home, { toolName: 'edit', input: { path: '/etc/passwd' } })?.block, true);
  assert.equal(workspaceGuard(home, { toolName: 'write', input: { path: '..safe/file' } }), undefined);
  assert.equal(workspaceGuard(home, { toolName: 'write', input: { path: 'new/file' } }), undefined);
});

test('test tool cannot bypass shell permissions; regex tricks do not matter', () => {
  const state = { permissionMode: 'dangerous', allowedTools: new Set() };
  assert.equal(needsPermission(state, { toolName: 'bash', input: { command: 'r"m" -rf x' } }), true);
  assert.equal(needsPermission(state, { toolName: 'test', input: { command: 'anything' } }), true);
  state.allowedTools.add('test'); assert.equal(needsPermission(state, { toolName: 'test' }), false);
});

for (const useHome of [false, true]) test(`real sandbox masks credentials and control state (${useHome ? 'home' : 'General'} workspace)`, async t => {
  const f = fixture(t);
  const workspace = useHome ? f.home : f.general;
  const code = `const fs=require('node:fs'); const home=${JSON.stringify(f.home)};
    const secrets=['.config/secrets/canary','.ssh/canary','.aws/canary','.netrc','.git-credentials','control/workbench.sqlite'];
    for(const file of secrets){try{if(fs.readFileSync(home+'/'+file,'utf8').includes('SECRET_CANARY'))throw Error('LEAK '+file);}catch(e){if(e.message.startsWith('LEAK'))throw e;}}
    if(process.env.WORKBENCH_PROXY_KEY || process.env.CLOUDFLARE_API_TOKEN)throw Error('env leak');
    fs.writeFileSync('allowed','ok'); fs.writeFileSync('/tmp/scratch','ok');
    try{fs.writeFileSync('/etc/workbench-denied','bad');throw Error('outside write');}catch(e){if(e.message==='outside write')throw e;}
    console.log('safe');`;
  const result = await collect(sandboxSpawn(process.execPath, ['-e', code], { ...f, workspace }, { env: { ...process.env, HOME: f.home, WORKBENCH_PROXY_KEY: 'CANARY', CLOUDFLARE_API_TOKEN: 'CANARY' }, stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /safe/);
});

test('real sandbox masks credential stores (gh, mcp-auth, docker, kube, npmrc, pypirc)', async t => {
  const f = fixture(t);
  const code = `const fs=require('node:fs');const home=${JSON.stringify(f.home)};
    const stores=['.config/gh/hosts.yml','.local/share/opencode/mcp-auth.json','.docker/config.json','.kube/config','.npmrc','.pypirc'];
    for(const file of stores){let content='';try{content=fs.readFileSync(home+'/'+file,'utf8');}catch{}if(content.includes('SECRET_CANARY'))throw new Error('LEAK '+file);}
    console.log('creds-safe');`;
  const result = await collect(sandboxSpawn(process.execPath, ['-e', code], { ...f, workspace: f.general }, { stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /creds-safe/);
});

test('home workspace cannot persist via shell/systemd startup files', async t => {
  const f = fixture(t);
  // workspace === HOME re-binds home read-write, so these paths must be masked
  // even though they are outside the "workspace" guard.
  const code = `const fs=require('node:fs');const home=${JSON.stringify(f.home)};
    const attempts=['.bashrc','.bash_profile','.profile','.zshrc','.config/systemd/user/evil.service','.config/autostart/evil.desktop','.config/environment.d/evil.conf','.local/bin/evil'];
    for(const file of attempts){try{fs.writeFileSync(home+'/'+file,'PWNED');}catch{}}
    fs.writeFileSync('workspace-ok','1');
    console.log('done');`;
  const result = await collect(sandboxSpawn(process.execPath, ['-e', code], { ...f, workspace: f.home }, { stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.equal(result.code, 0, result.stderr);
  const { readFileSync, existsSync } = await import('node:fs');
  for (const file of ['.bashrc', '.bash_profile', '.profile', '.zshrc', '.config/systemd/user/evil.service', '.config/autostart/evil.desktop', '.config/environment.d/evil.conf', '.local/bin/evil']) {
    const content = existsSync(`${f.home}/${file}`) ? readFileSync(`${f.home}/${file}`, 'utf8') : '';
    assert.ok(!content.includes('PWNED'), `${file} was written through the sandbox`);
  }
  assert.equal(readFileSync(`${f.home}/workspace-ok`, 'utf8'), '1');
});

test('two real sandboxed processes overlap in the same General directory', async t => {
  const f = fixture(t);
  const run = id => sandboxSpawn(process.execPath, ['-e', `const fs=require('node:fs');fs.writeFileSync('${id}.start',String(Date.now()));setTimeout(()=>{fs.writeFileSync('${id}.end',String(Date.now()));console.log('done')},400)`], { ...f, workspace: f.general }, { stdio: ['ignore', 'pipe', 'pipe'] });
  const results = await Promise.all([collect(run('a')), collect(run('b'))]);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const { readFileSync } = await import('node:fs');
  const timestamp = name => Number(readFileSync(`${f.general}/${name}`));
  assert.ok(Math.max(timestamp('a.start'), timestamp('b.start')) < Math.min(timestamp('a.end'), timestamp('b.end')));
});

test('plan sandbox denies workspace writes', async t => {
  const f = fixture(t);
  const result = await collect(sandboxSpawn(process.execPath, ['-e', "try{require('node:fs').writeFileSync('denied','x');process.exit(1)}catch{console.log('denied')}"], { ...f, workspace: f.general, readOnly: true }, { stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.equal(result.code, 0, result.stderr);
});

test('TERM-resistant sandbox process is killed and reaped within deadline', async t => {
  const f = fixture(t);
  const child = sandboxSpawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"], { ...f, workspace: f.general }, { stdio: ['ignore', 'pipe', 'pipe'] });
  const result = collect(child);
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', () => reject(new Error('Exited before ready'))); });
  terminateGroup(child, 50);
  const exit = await result;
  assert.ok(exit.signal || exit.code !== 0);
});
