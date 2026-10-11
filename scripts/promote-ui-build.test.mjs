import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const promoter = path.join(repositoryRoot, 'scripts', 'promote-ui-build.mjs');
const assetChecker = path.join(repositoryRoot, 'scripts', 'check-ui-assets.mjs');

test('promotion switches to complete staged output before pruning stale bundles', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workbench-promote-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const publicRoot = path.join(root, 'public');
  const staging = path.join(publicRoot, 'build-staging');
  const publicAssets = path.join(publicRoot, 'assets');
  const stagedAssets = path.join(staging, 'assets');
  await mkdir(publicAssets, { recursive: true });
  await mkdir(stagedAssets, { recursive: true });
  await writeFile(path.join(publicRoot, 'index.html'), '<script src="/assets/old-main.js"></script>');
  const oldAsset = path.join(publicAssets, 'old-main.js');
  await writeFile(oldAsset, 'old bundle');
  const stale = new Date(Date.now() - 8 * 86400_000);
  await utimes(oldAsset, stale, stale);
  await writeFile(path.join(staging, 'index.html'), '<script type="module" src="/assets/new-main.js"></script>');
  await writeFile(path.join(stagedAssets, 'new-main.js'), 'new bundle');

  const result = spawnSync(process.execPath, [promoter, root], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(await readFile(path.join(publicRoot, 'index.html'), 'utf8'), /new-main\.js/);
  assert.equal(await readFile(path.join(publicAssets, 'new-main.js'), 'utf8'), 'new bundle');
  await assert.rejects(stat(oldAsset), { code: 'ENOENT' });
  await assert.rejects(stat(staging), { code: 'ENOENT' });

  const check = spawnSync(process.execPath, [assetChecker, publicRoot], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr || check.stdout);
});
