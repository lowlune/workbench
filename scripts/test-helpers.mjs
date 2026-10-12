import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tempDir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

let sandboxCapability;
export function sandboxAvailable() {
  if (sandboxCapability !== undefined) return sandboxCapability;
  try {
    execFileSync('/usr/bin/bwrap', [
      '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin',
      '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
      '--unshare-pid', '--proc', '/proc', '--dev', '/dev', '--', '/bin/true',
    ], { timeout: 5000, stdio: 'pipe', env: { HOME: process.env.HOME || os.homedir(), PATH: process.env.PATH || '' } });
    sandboxCapability = true;
  } catch {
    sandboxCapability = false;
  }
  return sandboxCapability;
}
