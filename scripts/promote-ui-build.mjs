import { copyFile, mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.resolve(root, 'public');
const staging = path.resolve(publicRoot, 'build-staging');
const stagedAssets = path.join(staging, 'assets');
const publicAssets = path.join(publicRoot, 'assets');
const stagedIndex = path.join(staging, 'index.html');
const nextIndex = path.join(publicRoot, `.index-${process.pid}.html`);
const activeIndex = path.join(publicRoot, 'index.html');

if (path.dirname(staging) !== publicRoot || path.dirname(publicAssets) !== publicRoot) {
  throw new Error('Refusing to promote UI assets outside the public directory.');
}

await mkdir(publicAssets, { recursive: true });
for (const entry of await readdir(stagedAssets, { withFileTypes: true })) {
  if (!entry.isFile() || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name)) continue;
  await copyFile(path.join(stagedAssets, entry.name), path.join(publicAssets, entry.name));
}

await copyFile(stagedIndex, nextIndex);
await rename(nextIndex, activeIndex);
await rm(staging, { recursive: true, force: true });
console.log('Promoted the new Workbench UI without interrupting requests for the previous build.');
