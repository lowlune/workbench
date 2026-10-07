import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fail, uid } from './store.mjs';

/* Git worktree isolation (PLAN §12/§13).

   A mutating Pi run in a Git project executes in a throwaway worktree so the
   user's checkout is never touched. The worktree is based on a stash commit of
   the current tree, so uncommitted tracked changes are part of the baseline and
   are NOT attributed to the agent. Applying the run is a strict patch applied
   back to the original checkout; any mismatch is reported as a conflict instead
   of silently merging or overwriting user edits. */

const HOME = process.env.HOME || os.homedir();
const GIT = process.env.WORKBENCH_GIT_BIN || '/usr/bin/git';
const ROOT = process.env.WORKBENCH_WORKTREE_ROOT || path.join(HOME, '.local/share/workbench/worktrees');
const preparations = new Map();

export const worktreeRoot = () => ROOT;

export const git = (args, options = {}) => new Promise((resolve) => {
  execFile(GIT, ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '--no-pager', ...args], { timeout: 60000, maxBuffer: 32 * 1024 * 1024, ...options }, (error, stdout, stderr) => resolve({ error, stdout: stdout || '', stderr: stderr || '' }));
});

function safeSegment(value) {
  return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 80) || 'default';
}

export async function isGitRepo(directory) {
  const result = await git(['-C', directory, 'rev-parse', '--is-inside-work-tree']);
  return !result.error && result.stdout.trim() === 'true';
}

async function currentBranch(directory) {
  const result = await git(['-C', directory, 'rev-parse', '--abbrev-ref', 'HEAD']);
  if (result.error) return null;
  const value = result.stdout.trim();
  return value === 'HEAD' ? null : value;
}

/* Creates the worktree under ~/.local/share/workbench/worktrees/<project>/<runId>.
   `stash create` captures tracked uncommitted changes in a dangling commit
   without altering the working tree, so the baseline is exact and safe. */
export async function createWorktree(options) {
  // Git's index/stash preparation needs a short per-checkout critical section.
  // This ends before the agent starts; it is never a run/directory lease.
  const root = options.root;
  const previous = preparations.get(root) || Promise.resolve();
  const pending = previous.catch(() => {}).then(() => prepareWorktree(options));
  preparations.set(root, pending);
  try { return await pending; }
  finally { if (preparations.get(root) === pending) preparations.delete(root); }
}

async function prepareWorktree({ projectId, conversationId, runId, root }) {
  const head = (await git(['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  if (!head) throw fail('The project has no commits yet; worktree isolation needs an initial commit.', 409);
  const baseBranch = await currentBranch(root);
  const stash = await git(['-C', root, 'stash', 'create']);
  if (stash.error) throw fail(`Could not capture the project baseline: ${stash.stderr || stash.error.message}`, 409);
  const baseCommit = (!stash.error && stash.stdout.trim()) || head;
  const directory = path.join(ROOT, safeSegment(projectId), safeSegment(runId));
  mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
  const branch = `workbench/run-${safeSegment(runId)}`;
  const added = await git(['-C', root, 'worktree', 'add', '-b', branch, directory, baseCommit]);
  if (added.error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw fail(`Could not create the isolated worktree: ${(added.stderr || added.error.message || '').trim().slice(0, 300)}`, 500);
  }
  return {
    id: uid('wt_'), path: directory, branch, baseBranch, baseCommit,
    projectId, conversationId, runId, root,
  };
}

/* Stages everything (including untracked files) in the throwaway worktree and
   returns a complete binary patch relative to the baseline. This never mutates
   the user's original checkout. */
export async function worktreeChanges(worktree, { includePatch = true } = {}) {
  const directory = worktree.path;
  if (!existsSync(directory)) return { status: 'missing', files: [], additions: 0, deletions: 0, patch: '' };
  const staged = await git(['-C', directory, 'add', '-A']);
  if (staged.error) throw fail(`Could not inspect worktree: ${staged.stderr || staged.error.message}`, 409);
  const numstat = await git(['-C', directory, 'diff', '--cached', '--numstat', worktree.baseCommit, '--']);
  const files = [];
  let additions = 0;
  let deletions = 0;
  for (const line of numstat.stdout.split('\n')) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
    if (!match) continue;
    const added = match[1] === '-' ? 0 : Number(match[1]);
    const removed = match[2] === '-' ? 0 : Number(match[2]);
    additions += added;
    deletions += removed;
    files.push({ path: match[3], additions: added, deletions: removed, binary: match[1] === '-' });
  }
  let patch = '';
  if (includePatch && files.length) {
    const diff = await git(['-C', directory, 'diff', '--cached', '--binary', worktree.baseCommit, '--']);
    patch = diff.stdout;
  }
  return {
    status: 'active', worktreeId: worktree.id, branch: worktree.branch,
    baseCommit: worktree.baseCommit, files, additions, deletions, patch,
  };
}

/* Strict apply back to the original checkout. Any mismatch (user edited the
   file meanwhile, or context no longer matches) is surfaced as a conflict and
   nothing is written. */
export async function applyWorktree(worktree, root) {
  const directory = worktree.path;
  if (!existsSync(directory)) throw fail('This worktree no longer exists on disk.', 404);
  const staged = await git(['-C', directory, 'add', '-A']);
  if (staged.error) throw fail(`Could not stage worktree changes: ${staged.stderr || staged.error.message}`, 409);
  const diff = await git(['-C', directory, 'diff', '--cached', '--binary', worktree.baseCommit, '--']);
  if (diff.error) throw fail(`Could not read worktree patch: ${diff.stderr || diff.error.message}`, 409);
  const patch = diff.stdout;
  if (!patch.trim()) return { status: 'applied', files: [], additions: 0, deletions: 0 };
  const numstat = await git(['-C', directory, 'diff', '--cached', '--numstat', worktree.baseCommit, '--']);
  const files = [];
  for (const line of numstat.stdout.split('\n')) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
    if (match) files.push({ path: match[3], additions: match[1] === '-' ? 0 : Number(match[1]), deletions: match[2] === '-' ? 0 : Number(match[2]) });
  }
  const temp = path.join(os.tmpdir(), `workbench-${safeSegment(worktree.id)}-${Date.now()}.patch`);
  await writeFile(temp, patch, { mode: 0o600 });
  try {
    const check = await git(['-C', root, 'apply', '--check', '--binary', temp]);
    if (check.error) return { status: 'conflict', files, error: (check.stderr || check.error.message || 'The changes no longer apply cleanly.').trim().slice(0, 600) };
    const apply = await git(['-C', root, 'apply', '--binary', temp]);
    if (apply.error) return { status: 'conflict', files, error: (apply.stderr || apply.error.message || 'The changes no longer apply cleanly.').trim().slice(0, 600) };
    return { status: 'applied', files, additions: files.reduce((sum, file) => sum + file.additions, 0), deletions: files.reduce((sum, file) => sum + file.deletions, 0) };
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

/* Removes the worktree and deletes its branch. The original checkout is never
   modified, so discarding can never destroy user changes. */
export async function discardWorktree(worktree, root) {
  if (existsSync(worktree.path)) {
    const removed = await git(['-C', root, 'worktree', 'remove', '--force', worktree.path]);
    if (removed.error) {
      const pruned = await git(['-C', root, 'worktree', 'prune']);
      if (pruned.error || existsSync(worktree.path)) {
        throw fail(`Could not remove the worktree: ${(removed.stderr || removed.error.message || '').trim().slice(0, 300)}`, 500);
      }
    }
  }
  if (worktree.branch) await git(['-C', root, 'branch', '-D', worktree.branch]);
  return { status: 'discarded' };
}

export async function readPatch(worktree) {
  return (await worktreeChanges(worktree, { includePatch: true })).patch;
}
