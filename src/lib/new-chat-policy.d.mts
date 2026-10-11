export const GENERAL_WORKSPACE_VALUE: '__general__';
export function preferredNewChatWorkspace<T extends { directory: string }>(
  directories: readonly T[],
  projectFilter?: string | null,
  activeDirectory?: string | null,
  lastDirectory?: string | null,
): string;
export function makeNewChatPayload<E extends 'pi' | 'opencode'>(
  engine: E,
  workspace: string,
): { title: string; engine: E; workspace?: string; mode: 'build' };
