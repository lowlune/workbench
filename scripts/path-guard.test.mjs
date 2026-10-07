import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import path from 'node:path';
import { insideDir, resolvedPath } from '../server/security.mjs';

/* The AGENTS.md POST route (server/control.mjs) guards a project-relative path
   with insideDir(resolvedPath(root), resolvedPath(file)) after requiring the
   basename to be AGENTS.md. These are exactly those production primitives. */
function agentsAllowed(root, requested) {
  const file = path.resolve(root, requested);
  if (path.basename(file) !== 'AGENTS.md') return false;
  return insideDir(resolvedPath(root), resolvedPath(file));
}

test('AGENTS.md path guard rejects directory-symlink escapes and traversal, allows nested files', t => {
  const root = mkdtempSync('/tmp/opencode/wb-agents-');
  mkdirSync(path.join(root, 'sub'), { recursive: true });
  symlinkSync('/etc', path.join(root, 'escape'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(agentsAllowed(root, 'AGENTS.md'), true);
  assert.equal(agentsAllowed(root, 'sub/AGENTS.md'), true);
  assert.equal(agentsAllowed(root, 'escape/AGENTS.md'), false);
  assert.equal(agentsAllowed(root, 'escape/passwd'), false);
  assert.equal(agentsAllowed(root, '../outside/AGENTS.md'), false);
});
