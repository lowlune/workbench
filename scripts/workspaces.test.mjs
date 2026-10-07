import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { sandboxSpawn } from '../server/security.mjs';

test('parallel worktrees preserve dirty baseline, strict apply conflicts, safe discard', async t => {
  const dir = mkdtempSync('/tmp/opencode/wb-worktrees-'); const root = `${dir}/project`;
  mkdirSync(root); process.env.WORKBENCH_WORKTREE_ROOT = `${dir}/worktrees`;
  const { createWorktree, applyWorktree, discardWorktree, isGitRepo } = await import('../server/workspaces.mjs');
  const git = args => execFileSync('/usr/bin/git', ['-C', root, ...args], { stdio: 'pipe' });
  git(['init']); writeFileSync(`${root}/file.txt`, 'base\n'); git(['add', '.']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture']);
  writeFileSync(`${root}/file.txt`, 'user dirty baseline\n');
  const worktrees = await Promise.all(['first-run', 'second-run'].map(runId => createWorktree({ projectId: 'project', conversationId: runId, runId, root })));
  t.after(async () => { for (const worktree of worktrees) if (existsSync(worktree.path)) await discardWorktree(worktree, root); rmSync(dir, { recursive: true, force: true }); });
  assert.notEqual(worktrees[0].path, worktrees[1].path);
  for (const worktree of worktrees) assert.equal(readFileSync(`${worktree.path}/file.txt`, 'utf8'), 'user dirty baseline\n');
  // The sandbox permits normal linked-worktree git operations, but cannot
  // rewrite the original checkout's config/hooks or .git redirection file.
  const dataDir = `${dir}/control`; mkdirSync(dataDir);
  const child = sandboxSpawn(process.execPath, ['-e', `
    const fs=require('node:fs'),cp=require('node:child_process');
    cp.execFileSync('/usr/bin/git',['status','--short']);
    cp.execFileSync('/usr/bin/git',['add','-A']);
    for(const file of [${JSON.stringify(`${root}/.git/config`)},'.git']){
      try{fs.writeFileSync(file,'bad');throw Error('metadata writable')}catch(e){if(e.message==='metadata writable')throw e;}
    }
  `], { workspace: worktrees[0].path, home: dir, dataDir }, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; }); child.stdout.resume();
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0, stderr);
  writeFileSync(`${worktrees[0].path}/file.txt`, 'agent change\n');
  assert.equal(readFileSync(`${root}/file.txt`, 'utf8'), 'user dirty baseline\n');
  assert.equal((await applyWorktree(worktrees[0], root)).status, 'applied');
  writeFileSync(`${worktrees[1].path}/file.txt`, 'conflicting agent\n');
  assert.equal((await applyWorktree(worktrees[1], root)).status, 'conflict');
  assert.equal(readFileSync(`${root}/file.txt`, 'utf8'), 'agent change\n');
  await discardWorktree(worktrees[1], root);
  assert.equal(existsSync(worktrees[1].path), false);
  assert.equal(await isGitRepo(dir), false);
});
