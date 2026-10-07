import { DatabaseSync } from 'node:sqlite';
import { cp, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const data = process.env.WORKBENCH_DATA || path.resolve(import.meta.dirname, '../data');
const root = process.env.WORKBENCH_BACKUP_DIR || path.join(os.homedir(), '.local/share/workbench-backups');
const worktrees = process.env.WORKBENCH_WORKTREE_ROOT || path.join(data, 'worktrees');
const nativeDb = path.join(os.homedir(), '.local/share/opencode/opencode.db');

await mkdir(root, { recursive: true, mode: 0o700 });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = path.join(root, stamp);
// Snapshot into a hidden temp dir and rename it into place only once every copy
// succeeds, so a crash or ENOSPC can never leave a half-written backup behind.
const temp = path.join(root, `.${stamp}.partial`);
await rm(temp, { recursive: true, force: true });
await mkdir(temp, { mode: 0o700 });

function copy(source, destination) {
  return cp(source, destination, { recursive: true }).catch(error => {
    if (error.code === 'ENOENT') return;
    throw error;
  });
}

function snapshot(source, destination, required = false) {
  if (!existsSync(source)) {
    if (required) throw new Error(`Missing backup source: ${source}`);
    return;
  }
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 10000');
    db.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`);
  } finally { db.close(); }
}

try {
  snapshot(path.join(data, 'control/workbench.sqlite'), path.join(temp, 'workbench.sqlite'), true);
  await copy(path.join(data, 'control/blobs'), path.join(temp, 'blobs'));
  await copy(path.join(data, 'control/pi/sessions'), path.join(temp, 'pi-sessions'));
  // These used to be silently omitted from every snapshot: agent workspaces
  // (control/general and control/workspaces) and the git worktree root.
  await copy(path.join(data, 'control/general'), path.join(temp, 'general'));
  await copy(path.join(data, 'control/workspaces'), path.join(temp, 'workspaces'));
  await copy(worktrees, path.join(temp, 'worktrees'));
  snapshot(nativeDb, path.join(temp, 'opencode.sqlite'));
  await rename(temp, target);
  console.log(`Workbench snapshot saved: ${target}`);
} catch (error) {
  await rm(temp, { recursive: true, force: true });
  throw error;
}

// Retention: keep the newest five COMPLETE snapshots. Partial/temp dirs (and
// anything missing the workbench.sqlite marker) never count toward the limit.
const backups = (await readdir(root, { withFileTypes: true }))
  .filter(entry => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}T/.test(entry.name) && existsSync(path.join(root, entry.name, 'workbench.sqlite')))
  .sort((a, b) => b.name.localeCompare(a.name));
for (const old of backups.slice(5)) await rm(path.join(root, old.name), { recursive: true, force: true });
