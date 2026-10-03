import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const home = process.env.HOME || os.homedir();
const root = path.resolve(import.meta.dirname, '..');
const source = path.join(home, '.cache', 'opencode', 'models.json');
const dataDirectory = path.join(root, 'data');
const destination = path.join(dataDirectory, 'model-catalog.json');
const catalog = {};

try {
  const providers = JSON.parse(await readFile(source, 'utf8'));
  for (const [providerID, provider] of Object.entries(providers)) {
    for (const [id, model] of Object.entries(provider?.models || {})) {
      if (!model || typeof model !== 'object') continue;
      const contextLimit = Number(model.limit?.context || 0);
      const outputLimit = Number(model.limit?.output || 0);
      catalog[`${providerID}/${id}`] = {
        name: typeof model.name === 'string' ? model.name : id,
        ...(Number.isSafeInteger(contextLimit) && contextLimit > 0 ? { contextLimit } : {}),
        ...(Number.isSafeInteger(outputLimit) && outputLimit > 0 ? { outputLimit } : {}),
      };
    }
  }
} catch {
  // A missing models.dev cache is fine; chat still shows the provider/model IDs.
}

await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
await writeFile(destination, JSON.stringify(catalog), { mode: 0o600 });
console.log(`Synced context limits for ${Object.keys(catalog).length} local models.`);
