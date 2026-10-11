import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checker = path.join(repositoryRoot, 'scripts', 'check-ui-assets.mjs');

async function makeFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workbench-assets-'));
  const staging = path.join(root, 'staging');
  const fallback = path.join(root, 'public');
  await mkdir(path.join(staging, 'assets'), { recursive: true });
  await mkdir(path.join(fallback, 'fonts'), { recursive: true });
  return { root, staging, fallback };
}

function runChecker(staging, fallback) {
  return spawnSync(process.execPath, [checker, staging, fallback], { encoding: 'utf8' });
}

test('asset checker follows HTML, JS imports, CSS URLs, and static fallback files', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await writeFile(path.join(fixture.staging, 'index.html'), '<script type="module" src="/assets/main.js"></script><link rel="stylesheet" href="/assets/main.css">');
  await writeFile(path.join(fixture.staging, 'assets', 'main.js'), 'import "./lazy.js"; export const icon = new URL("./icon.svg", import.meta.url);');
  await writeFile(path.join(fixture.staging, 'assets', 'lazy.js'), 'export const ready = true;');
  await writeFile(path.join(fixture.staging, 'assets', 'icon.svg'), '<svg/>');
  await writeFile(path.join(fixture.staging, 'assets', 'main.css'), '@font-face { src: url("/fonts/inter.woff2"); }');
  await writeFile(path.join(fixture.fallback, 'fonts', 'inter.woff2'), 'font');

  const result = runChecker(fixture.staging, fixture.fallback);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /UI asset check passed/);
});

test('asset checker rejects missing hashed bundles even when an old copy exists in fallback', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await writeFile(path.join(fixture.staging, 'index.html'), '<script type="module" src="/assets/new-main.js"></script>');
  await mkdir(path.join(fixture.fallback, 'assets'), { recursive: true });
  await writeFile(path.join(fixture.fallback, 'assets', 'new-main.js'), 'old bundle');

  const result = runChecker(fixture.staging, fixture.fallback);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing assets\/new-main\.js/);
});

test('asset checker rejects missing transitive font references', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await writeFile(path.join(fixture.staging, 'index.html'), '<link rel="stylesheet" href="/assets/main.css">');
  await writeFile(path.join(fixture.staging, 'assets', 'main.css'), 'body { font-family: Inter; src: url("/fonts/missing.woff2"); }');

  const result = runChecker(fixture.staging, fixture.fallback);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing fonts\/missing\.woff2/);
});
