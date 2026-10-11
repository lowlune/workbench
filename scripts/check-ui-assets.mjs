import fs from 'node:fs';
import path from 'node:path';

const publicRoot = path.resolve(process.argv[2] || 'public');
const fallbackRoot = process.argv[3] ? path.resolve(process.argv[3]) : null;
const indexFile = path.join(publicRoot, 'index.html');
const assetExtension = /\.(?:avif|css|gif|ico|jpeg|jpg|js|json|mjs|otf|png|svg|webmanifest|wasm|webp|woff2?|ttf)(?:$|[?#])/i;
const pending = [];
const visited = new Set();
const failures = [];

function queueReference(reference, importer, always = false) {
  const value = reference.trim();
  if (!value || value.startsWith('#') || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value)) return;
  if (!always && !assetExtension.test(value) && !/^\/?assets\//.test(value)) return;
  pending.push({ reference: value, importer, always });
}

function collectReferences(file, content) {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.html') {
    for (const match of content.matchAll(/\b(?:src|href|poster)\s*=\s*["']([^"']+)["']/gi)) {
      queueReference(match[1], file);
    }
  }
  if (extension === '.js' || extension === '.mjs') {
    const patterns = [
      /\bimport\s+["']([^"']+)["']/g,
      /\bfrom\s+["']([^"']+)["']/g,
      /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
      /\bnew\s+URL\s*\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g,
    ];
    for (const pattern of patterns) {
      for (const match of content.matchAll(pattern)) queueReference(match[1], file, true);
    }
  }
  if (extension === '.css') {
    const patterns = [
      /\burl\(\s*["']?([^"')]+)["']?\s*\)/gi,
      /@import\s+["']([^"']+)["']/gi,
    ];
    for (const pattern of patterns) {
      for (const match of content.matchAll(pattern)) queueReference(match[1], file, true);
    }
  }
}

function contains(root, target) {
  return target === root || target.startsWith(root + path.sep);
}

function resolveReference(reference, importer) {
  const root = contains(publicRoot, importer) ? publicRoot : fallbackRoot;
  if (!root) throw new Error(`cannot resolve ${reference} from outside the checked public root`);
  let pathname = reference.split(/[?#]/, 1)[0];
  try { pathname = decodeURIComponent(pathname); } catch { /* Keep the literal path for a useful error. */ }
  const resolved = path.resolve(root, pathname.startsWith('/')
    ? pathname.slice(1)
    : path.relative(root, path.dirname(importer)) + path.sep + pathname);
  if (!contains(root, resolved)) {
    throw new Error(`reference escapes public root: ${reference} (from ${path.relative(root, importer)})`);
  }
  return resolved;
}

if (!fs.existsSync(indexFile)) {
  console.error(`UI asset check failed: ${indexFile} does not exist.`);
  process.exit(1);
}

queueReference('/index.html', indexFile, true);
while (pending.length) {
  const item = pending.shift();
  let target;
  try {
    target = resolveReference(item.reference, item.importer);
  } catch (error) {
    failures.push(error.message);
    continue;
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    const relativeTarget = path.relative(publicRoot, target);
    const mayUseFallback = fallbackRoot && relativeTarget !== '..' && !relativeTarget.startsWith(`..${path.sep}`)
      && !relativeTarget.startsWith(`assets${path.sep}`) && !relativeTarget.startsWith('assets/');
    const fallbackTarget = mayUseFallback ? path.resolve(fallbackRoot, relativeTarget) : '';
    if (fallbackTarget && fs.existsSync(fallbackTarget) && fs.statSync(fallbackTarget).isFile()) {
      target = fallbackTarget;
    } else {
      failures.push(`${path.relative(path.dirname(indexFile), item.importer)} -> ${item.reference} (missing ${relativeTarget})`);
      continue;
    }
  }
  if (visited.has(target)) continue;
  visited.add(target);
  if (/\.(?:html|js|mjs|css)$/i.test(target)) {
    collectReferences(target, fs.readFileSync(target, 'utf8'));
  }
}

if (failures.length) {
  console.error(`UI asset check failed with ${failures.length} missing or invalid reference(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`UI asset check passed (${visited.size} referenced files under ${publicRoot}).`);
