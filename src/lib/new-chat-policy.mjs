export const GENERAL_WORKSPACE_VALUE = '__general__';

export function preferredNewChatWorkspace(directories, projectFilter = null, activeDirectory = null, lastDirectory = null) {
  const available = new Set(directories.map((item) => item.directory));
  for (const candidate of [projectFilter, activeDirectory, lastDirectory]) {
    if (candidate && available.has(candidate)) return candidate;
  }
  return directories.length === 1 ? directories[0].directory : '';
}

export function makeNewChatPayload(engine, workspace) {
  const directory = workspace === GENERAL_WORKSPACE_VALUE ? '' : workspace;
  return {
    title: 'New conversation',
    engine,
    ...(directory ? { workspace: directory } : {}),
    mode: 'build',
  };
}
