import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fonts = path.join(root, 'public', 'fonts');
const inter = path.join(root, 'node_modules', '@fontsource-variable', 'inter');

await mkdir(fonts, { recursive: true });
await copyFile(path.join(inter, 'files', 'inter-latin-wght-normal.woff2'), path.join(fonts, 'inter-latin-wght-normal.woff2'));
await copyFile(path.join(inter, 'files', 'inter-latin-ext-wght-normal.woff2'), path.join(fonts, 'inter-latin-ext-wght-normal.woff2'));
await copyFile(path.join(inter, 'LICENSE'), path.join(fonts, 'OFL-Inter.txt'));

await writeFile(path.join(fonts, 'inter.css'), `@font-face {
  font-family: "Inter Variable";
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url("./inter-latin-ext-wght-normal.woff2") format("woff2");
  unicode-range: U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF;
}
@font-face {
  font-family: "Inter Variable";
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url("./inter-latin-wght-normal.woff2") format("woff2");
  unicode-range: U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;
}
`);
console.log('Synced self-hosted Inter assets.');
