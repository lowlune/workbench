import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/* Radius guard: the UI uses exactly three corner radii plus pills.
     rounded-md   6px   — controls + details (buttons, inputs, rows, tabs, code, checkboxes)
     rounded-xl  12px   — surfaces (cards, panels, popovers, dialogs, wells, bubbles)
     rounded-3xl 24px   — capsules (composer, run summary, banners)
     rounded-full       — pills, avatars, dots
   (6 / 12 / 24 — each step doubles.) This check fails if any other radius (or
   a raw pixel value) creeps back in. Run from `npm run check`. */

const root = path.resolve('src');
const token = /rounded[A-Za-z0-9_\-[\]]*/g;
const allowed = /^rounded-(md|xl|3xl|full)$|^rounded-(t|b|l|r|tl|tr|bl|br|s|e|ss|se|es|ee)-(md|xl|3xl)$/;
const cssRadius = /border-radius:\s*([^;]+);/g;
const allowedCss = /^(0|999px|9999px|50%|inherit|var\(--radius-(md|xl|3xl|full)\))$/i;

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

const problems = [];
for await (const file of walk(root)) {
  if (!/\.(tsx|ts|css)$/.test(file)) continue;
  const lines = (await readFile(file, 'utf8')).split('\n');
  lines.forEach((line, index) => {
    if (file.endsWith('.css')) {
      for (const match of line.matchAll(cssRadius)) {
        const value = match[1].trim();
        if (!allowedCss.test(value)) problems.push(`${file}:${index + 1} border-radius: ${value}`);
      }
      return;
    }
    for (const match of line.matchAll(token)) {
      if (!allowed.test(match[0])) problems.push(`${file}:${index + 1} ${match[0]}`);
    }
  });
}

if (problems.length) {
  console.error('Radius scale violations (allowed: md 6 / xl 12 / 3xl 24 / full):');
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log('Radius scale OK (md 6 / xl 12 / 3xl 24 / full).');
