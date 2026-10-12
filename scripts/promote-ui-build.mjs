import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(process.argv[2] || defaultRoot);
const publicRoot = path.resolve(root, 'public');
const staging = path.resolve(publicRoot, 'build-staging');
const stagedAssets = path.join(staging, 'assets');
const publicAssets = path.join(publicRoot, 'assets');
const stagedIndex = path.join(staging, 'index.html');
const nextIndex = path.join(publicRoot, `.index-${process.pid}.html`);
const activeIndex = path.join(publicRoot, 'index.html');
const ASSET_RETENTION_MS = 7 * 86400_000;

if (path.dirname(staging) !== publicRoot || path.dirname(publicAssets) !== publicRoot) {
  throw new Error('Refusing to promote UI assets outside the public directory.');
}

function inside(directory, target) {
  const relative = path.relative(directory, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function gitOutput(args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

function indexHistoryState() {
  try { gitOutput(['rev-parse', '--show-toplevel']); }
  catch { return { kind: 'no-git' }; }
  try {
    if (gitOutput(['rev-parse', '--is-shallow-repository']) !== 'false') return { kind: 'shallow' };
    const history = gitOutput(['log', '--full-history', '--format=WB_INDEX:%ct:%H', '--', 'public/index.html'])
      .split(/\r?\n/)
      .map((line) => {
        const match = /^WB_INDEX:(\d+):([a-f0-9]{40,64})$/.exec(line);
        return match ? { committedAt: Number(match[1]) * 1000, sha: match[2] } : null;
      })
      .filter(Boolean);
    return history.length ? { kind: 'full', history } : { kind: 'missing-history' };
  } catch {
    return { kind: 'missing-history' };
  }
}

function assetReferences(indexHtml) {
  const pending = [];
  const visited = new Set();
  const referenced = new Set();
  const assetExtension = /\.(?:avif|css|gif|ico|jpeg|jpg|js|json|mjs|otf|png|svg|webmanifest|wasm|webp|woff2?|ttf)(?:$|[?#])/i;

  function queue(reference, importer, always = false) {
    const value = reference.trim();
    if (!value || value.startsWith('#') || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value)) return;
    if (!always && !assetExtension.test(value) && !/^\/?assets\//.test(value)) return;
    pending.push({ value, importer });
  }

  function collect(file, content) {
    const extension = path.extname(file).toLowerCase();
    if (extension === '.html') {
      for (const match of content.matchAll(/\b(?:src|href|poster)\s*=\s*["']([^"']+)["']/gi)) queue(match[1], file);
    } else if (extension === '.js' || extension === '.mjs') {
      for (const pattern of [
        /\bimport\s+["']([^"']+)["']/g,
        /\bfrom\s+["']([^"']+)["']/g,
        /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
        /\bnew\s+URL\s*\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g,
      ]) for (const match of content.matchAll(pattern)) queue(match[1], file, true);
    } else if (extension === '.css') {
      for (const pattern of [
        /\burl\(\s*["']?([^"')]+)["']?\s*\)/gi,
        /@import\s+["']([^"']+)["']/gi,
      ]) for (const match of content.matchAll(pattern)) queue(match[1], file, true);
    }
  }

  visited.add(activeIndex);
  collect(activeIndex, indexHtml);
  while (pending.length) {
    const item = pending.shift();
    let pathname = item.value.split(/[?#]/, 1)[0];
    try { pathname = decodeURIComponent(pathname); } catch { /* Keep malformed paths out of the asset set. */ }
    const target = path.resolve(pathname.startsWith('/') ? publicRoot : path.dirname(item.importer), pathname.startsWith('/') ? pathname.slice(1) : pathname);
    if (!inside(publicRoot, target)) continue;

    if (inside(publicAssets, target) && target !== publicAssets) {
      referenced.add(path.relative(publicAssets, target).split(path.sep).join('/'));
    }
    if (visited.has(target) || !existsSync(target) || !statSync(target).isFile()) continue;
    visited.add(target);
    if (/\.(?:html|js|mjs|css)$/i.test(target)) collect(target, readFileSync(target, 'utf8'));
  }
  return referenced;
}

function retainedAssetNames(history) {
  const retained = assetReferences(readFileSync(activeIndex, 'utf8'));
  const cutoff = Date.now() - ASSET_RETENTION_MS;
  for (const entry of history) {
    if (entry.committedAt < cutoff) continue;
    const html = execFileSync('git', ['-C', root, 'show', `${entry.sha}:public/index.html`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 4 * 1024 * 1024,
    });
    for (const name of assetReferences(html)) retained.add(name);
  }
  return retained;
}

await mkdir(publicAssets, { recursive: true });
const stagedNames = new Set();
for (const entry of await readdir(stagedAssets, { withFileTypes: true })) {
  if (!entry.isFile() || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name)) continue;
  await copyFile(path.join(stagedAssets, entry.name), path.join(publicAssets, entry.name));
  stagedNames.add(entry.name);
}

const indexHistory = indexHistoryState();
let retainedNames = null;
if (indexHistory.kind === 'full') {
  try { retainedNames = retainedAssetNames(indexHistory.history); }
  catch { /* Fail safe: never prune bundles when complete Git history is unavailable. */ }
}
if (!retainedNames && indexHistory.kind === 'no-git') {
  /* Keep compatibility with source archives and the isolated promotion fixture.
     Git checkouts use index history, which survives checkout mtime resets. */
  retainedNames = new Set();
}
if (!retainedNames) console.warn('Skipped stale UI asset pruning because complete Git history is unavailable.');

/* Make the new entry point visible only after every referenced asset is in
   place. Keep old immutable assets available to existing pages for seven days. */
await copyFile(stagedIndex, nextIndex);
await rename(nextIndex, activeIndex);

/* Prune only after the atomic index switch. Preserve assets referenced by any
   committed index in the seven-day window. Git commit history is stable across
   fresh checkouts; checkout mtimes are not. */
if (retainedNames) {
  for (const entry of await readdir(publicAssets, { withFileTypes: true })) {
    if (!entry.isFile() || stagedNames.has(entry.name)) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name)) continue;
    if (retainedNames.has(entry.name)) continue;
    if (indexHistory.kind === 'no-git' && (await stat(path.join(publicAssets, entry.name))).mtimeMs >= Date.now() - ASSET_RETENTION_MS) continue;
    await rm(path.join(publicAssets, entry.name), { force: true });
  }
}

await rm(staging, { recursive: true, force: true });
console.log('Promoted the new Workbench UI without interrupting requests for the previous build.');
