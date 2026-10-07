import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Runtime/provider keys are read from dedicated auth stores, not inherited from
// the control plane. In particular NODE_OPTIONS/BASH_ENV/LD_PRELOAD are excluded.
export function agentEnv(source = process.env) {
  const allowed = new Set(['HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM', 'COLORTERM', 'SHELL']);
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => allowed.has(key) && typeof value === 'string'));
}

export function insideDir(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

// Resolve existing ancestors too: a new file below an escaping symlink must not
// evade the guard just because the final file does not exist yet.
export function resolvedPath(target) {
  try { return realpathSync(target); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(target);
    if (parent === target) throw error;
    return path.join(resolvedPath(parent), path.basename(target));
  }
}

export function workspaceGuard(root, event) {
  if (!['write', 'edit', 'multiedit', 'patch'].includes(event.toolName)) return;
  const input = event.input || {};
  const paths = [input.path, input.file_path, ...(Array.isArray(input.edits) ? input.edits.map(edit => edit?.path || edit?.file_path) : [])].filter(value => typeof value === 'string' && value);
  for (const candidate of paths) {
    try {
      const target = resolvedPath(path.resolve(root, candidate));
      if (insideDir(resolvedPath(root), target) || insideDir(resolvedPath(os.tmpdir()), target)) continue;
    } catch {}
    return { block: true, reason: `Blocked write outside workspace: ${candidate}` };
  }
}

let ready;
export function requireSandbox() {
  if (ready) return;
  if (['0', 'false'].includes(process.env.WORKBENCH_SANDBOX)) throw new Error('Agent execution requires bubblewrap; remove WORKBENCH_SANDBOX=0.');
  try {
    execFileSync('/usr/bin/bwrap', ['--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64', '--unshare-pid', '--proc', '/proc', '--dev', '/dev', '--', '/bin/true'], { timeout: 5000, stdio: 'pipe', env: agentEnv() });
    ready = true;
  } catch (error) { throw new Error(`Agent sandbox unavailable: ${String(error.stderr || error.message).trim().slice(0, 300)}`); }
}

export function gitMounts(workspace) {
  try {
    const run = flag => execFileSync('/usr/bin/git', ['-C', workspace, 'rev-parse', flag], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'], env: agentEnv() }).trim();
    const admin = realpathSync(run('--absolute-git-dir'));
    const common = realpathSync(path.resolve(workspace, run('--git-common-dir')));
    // Only an isolated linked worktree needs metadata writes. Never grant a
    // child write access to the original checkout's config/hooks/index.
    if (admin === common) return { rw: [], ro: [path.join(workspace, '.git')], masks: [] };
    return { rw: [admin, path.join(common, 'objects'), path.join(common, 'refs')],
      ro: [common, path.join(workspace, '.git')], masks: [path.join(admin, 'config.worktree')] };
  } catch { return { rw: [], ro: [], masks: [] }; }
}

// /etc/resolv.conf is commonly a symlink into /run (systemd-resolved). Binding
// its directory would leak the world-writable systemd-resolved varlink sockets
// into the sandbox, so instead build a tiny directory holding only a regular
// copy of the resolved file and read-only-overlay it onto /etc. This keeps DNS
// working while /run/systemd/resolve stays absent from the sandbox. Returns
// null when /etc/resolv.conf already lives inside /etc (plain read-only bind is
// enough) or is unreadable.
export function resolvConfOverlay() {
  let resolved;
  try { resolved = realpathSync('/etc/resolv.conf'); } catch { return null; }
  if (insideDir('/etc', resolved)) return null;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wb-resolv-'));
  writeFileSync(path.join(dir, 'resolv.conf'), readFileSync(resolved), { mode: 0o444 });
  return dir;
}

export function sandboxArgs({ workspace, dataDir, readOnly = false, extraRw = [], runtimeRw = [], home = process.env.HOME || os.homedir(), appRoot = path.resolve(import.meta.dirname, '..'), resolvConfDir = null }) {
  const args = ['--die-with-parent', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--new-session'];
  const mount = (flag, target) => { if (existsSync(target)) args.push(flag, target, target); };
  // Construct a small filesystem rather than exposing / (host /proc, /run,
  // service state, sockets and other users' homes must not leak into a run).
  for (const target of ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/opt']) mount('--ro-bind', target);
  // DNS: overlay /etc with a regular resolv.conf so the symlink into /run
  // resolves without exposing /run/systemd/resolve (see resolvConfOverlay).
  if (resolvConfDir) args.push('--overlay-src', '/etc', '--overlay-src', resolvConfDir, '--ro-overlay', '/etc');
  else mount('--ro-bind', '/etc');
  args.push('--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp');
  mount('--ro-bind', home);
  if (!insideDir(home, appRoot)) mount('--ro-bind', appRoot);
  mount(readOnly ? '--ro-bind' : '--bind', workspace);
  const metadata = gitMounts(workspace);
  for (const target of metadata.ro) mount('--ro-bind', target);
  for (const target of metadata.rw) mount(readOnly ? '--ro-bind' : '--bind', target);
  for (const target of metadata.masks) args.push('--ro-bind', '/dev/null', target);
  for (const target of extraRw) mount(readOnly ? '--ro-bind' : '--bind', target);
  // Mask control SQLite (which includes settings/SMTP secrets) even when the
  // selected workspace is HOME or the application checkout.
  if (existsSync(dataDir)) args.push('--tmpfs', dataDir);
  for (const target of runtimeRw) mount('--bind', target);
  mount('--ro-bind', path.join(dataDir, 'blobs'));
  if (workspace === dataDir) throw new Error('Control state is not an agent workspace. Choose General or another folder.');
  if (insideDir(dataDir, workspace)) {
    if (!['general', 'discovery', 'workspaces'].some(name => insideDir(path.join(dataDir, name), workspace))) throw new Error('Private control state is not an agent workspace.');
    mount(readOnly ? '--ro-bind' : '--bind', workspace);
  }
  // Apply masks last so a writable home/workspace cannot expose them again.
  // Roots the sandbox may write to. A missing mask target can only be
  // materialised by bubblewrap when its parent is writable; otherwise the
  // create fails with EROFS and would abort the whole spawn.
  const writableRoots = [...(readOnly ? [] : [workspace, ...extraRw]), ...runtimeRw];
  const canMaterialize = target => writableRoots.some(root => insideDir(root, target));
  const applyMask = (target, forceDirectory) => {
    const exists = existsSync(target);
    if (!exists && !canMaterialize(target)) return;
    const isDirectory = exists ? statSync(target).isDirectory() : forceDirectory;
    const values = new Set([target]);
    if (exists) { try { values.add(realpathSync(target)); } catch {} }
    for (const value of values) {
      if (isDirectory) args.push('--tmpfs', value);
      else args.push('--ro-bind', '/dev/null', value);
    }
  };
  // Credential stores the agent must never read.
  for (const target of [path.join(home, '.config/secrets'), path.join(home, '.ssh'), path.join(home, '.aws'), path.join(home, '.netrc'), path.join(home, '.git-credentials'), path.join(home, '.config/gcloud'), path.join(home, '.config/.wrangler'), path.join(home, '.wrangler'), path.join(home, '.config/gh'), path.join(home, '.local/share/opencode/mcp-auth.json'), path.join(home, '.docker'), path.join(home, '.kube'), path.join(home, '.npmrc'), path.join(home, '.pypirc')]) {
    applyMask(target, false);
  }
  // Shell startup files and user service definitions are persistence vectors
  // OUTSIDE the sandbox whenever HOME (or an ancestor) is the workspace, since
  // that re-binds home read-write. Mask them even then.
  for (const target of [path.join(home, '.bashrc'), path.join(home, '.bash_profile'), path.join(home, '.profile'), path.join(home, '.zshrc')]) applyMask(target, false);
  for (const target of [path.join(home, '.config/systemd/user'), path.join(home, '.config/autostart'), path.join(home, '.config/environment.d'), path.join(home, '.local/bin')]) applyMask(target, true);
  args.push('--setenv', 'XDG_CACHE_HOME', '/tmp/.cache', '--setenv', 'npm_config_cache', '/tmp/.npm', '--setenv', 'PIP_CACHE_DIR', '/tmp/.pip', '--chdir', workspace);
  return args;
}

export function sandboxSpawn(command, argv, sandbox, options = {}) {
  requireSandbox();
  const ownedResolv = sandbox.resolvConfDir ? null : resolvConfOverlay();
  const resolvConfDir = sandbox.resolvConfDir || ownedResolv;
  const { runtimeEnv = {}, ...spawnOptions } = options;
  let child;
  try {
    child = spawn('/usr/bin/bwrap', [...sandboxArgs({ ...sandbox, resolvConfDir }), '--', command, ...argv], { ...spawnOptions, detached: true, env: { ...agentEnv(options.env), ...runtimeEnv } });
  } catch (error) {
    if (ownedResolv) rmSync(ownedResolv, { recursive: true, force: true });
    throw error;
  }
  if (ownedResolv) {
    const cleanup = () => rmSync(ownedResolv, { recursive: true, force: true });
    child.once('close', cleanup);
    child.once('error', cleanup);
  }
  return child;
}

export function signalGroup(child, signal) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') console.warn(JSON.stringify({ event: 'process_signal_error', pid: child.pid, message: error.message })); }
}

export function terminateGroup(child, graceMs = 1500) {
  signalGroup(child, 'SIGTERM');
  const timer = setTimeout(() => signalGroup(child, 'SIGKILL'), graceMs);
  timer.unref();
  child.once('close', () => clearTimeout(timer));
}
