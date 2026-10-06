import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/* Workbench keeps its global AGENTS.md outside the Pi agent directory
   (`~/.config/workbench/AGENTS.md`), while DefaultResourceLoader only looks for
   the global context file inside `agentDir`. The override below merges the
   Workbench global file into the loader's `agentsFiles`, so it lands in the
   session system prompt via the loader's `<project_instructions>` pipeline
   (§29) instead of being resent with every prompt. */

export function readContextFile(file) {
  try {
    if (!existsSync(file) || !statSync(file).isFile()) return null;
    let content = readFileSync(file, 'utf8');
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
    if (!content.trim()) return null;
    return { path: file, content };
  } catch {
    return null;
  }
}

export function workbenchAgentsFile(home = process.env.HOME) {
  if (!home) return null;
  return readContextFile(path.join(home, '.config/workbench/AGENTS.md'));
}

export function createAgentsFilesOverride({ globalFile } = {}) {
  const global = globalFile && typeof globalFile.content === 'string' && globalFile.content.trim() ? globalFile : null;
  return ({ agentsFiles } = {}) => {
    const list = Array.isArray(agentsFiles) ? agentsFiles.slice() : [];
    if (global) {
      const key = path.resolve(global.path);
      if (!list.some((file) => file && typeof file.path === 'string' && path.resolve(file.path) === key)) {
        list.unshift({ path: global.path, content: global.content });
      }
    }
    return { agentsFiles: list };
  };
}
