import { generateUnifiedPatch } from '@earendil-works/pi-coding-agent';

export const TOOL_KIND = {
  read: 'file.read',
  grep: 'file.search',
  find: 'file.list',
  ls: 'file.list',
  edit: 'file.changed',
  write: 'file.changed',
  bash: 'command',
  powershell: 'command',
  todo: 'todo',
  ask_user: 'question',
  git: 'git',
  test: 'test',
};

export function classifyTool(toolName) {
  return TOOL_KIND[toolName] || 'tool';
}

export function pathArg(args) {
  return args && typeof args === 'object' && typeof args.path === 'string' ? args.path : undefined;
}

export function commandArg(args) {
  return args && typeof args === 'object' && typeof args.command === 'string' ? args.command : undefined;
}

/* Concatenated assistant text from a Pi message snapshot. Used to derive the
   increment for live `text.delta` without rescanning tool/other parts. */
export function textOfMessage(message) {
  const content = message && Array.isArray(message.content) ? message.content : [];
  let text = '';
  for (const part of content) if (part && part.type === 'text' && typeof part.text === 'string') text += part.text;
  return text;
}

/* Pi snapshots are cumulative; compare against the previous snapshot to get the
   incremental text. `resync` signals a structural reset (e.g. new text part
   after a tool call) that must be repaired by a full message snapshot instead
   of a delta. */
export function diffText(previous, next) {
  const prev = typeof previous === 'string' ? previous : '';
  const current = typeof next === 'string' ? next : '';
  if (current === prev) return { delta: '', resync: false };
  if (current.length > prev.length && current.startsWith(prev)) {
    return { delta: current.slice(prev.length), resync: false };
  }
  return { delta: '', resync: true };
}

/* A short, human-readable description of what the agent is doing right now
   (§27) — shown in the RunSummary card. */
export function currentAction(toolName, args = {}) {
  const path = pathArg(args);
  const command = commandArg(args);
  switch (toolName) {
    case 'read': return path ? `Reading ${path}` : 'Reading files';
    case 'grep': return path ? `Searching code in ${path}` : 'Searching code';
    case 'find': return 'Searching code';
    case 'ls': return path ? `Listing ${path}` : 'Listing files';
    case 'edit': return path ? `Editing ${path}` : 'Editing files';
    case 'write': return path ? `Writing ${path}` : 'Writing files';
    case 'bash': {
      const value = String(command || '').trim();
      if (/\b(npm|pnpm|yarn|bun|vitest|jest|pytest|go|cargo|make|deno|dotnet)\b[^\n]*\btest\b/i.test(value) || /\btest\b/i.test(value) && /\b(run|--)\b/.test(value)) return 'Running tests';
      if (/^git\b/.test(value)) return `Running git ${value.split(/\s+/)[1] || ''}`.trim();
      return value ? `Running ${clip(value, 60)}` : 'Running a command';
    }
    case 'test': return 'Running tests';
    case 'git': return `Inspecting git ${args.action || ''}`.trim();
    case 'todo': return 'Updating plan';
    case 'ask_user': return 'Waiting for your answer';
    default: return toolName ? `Using ${toolName}` : 'Working';
  }
}

/* Rough ETA (ms) from completed TODO fraction and elapsed run time (§28).
   Only returned once there is meaningful progress; otherwise the fields are
   omitted so the UI can fall back to its own estimate. */
export function estimateEta(todos, startedAt, now = Date.now()) {
  const list = Array.isArray(todos) ? todos : [];
  const total = list.length;
  const started = Number(startedAt);
  if (!total || !Number.isFinite(started) || started <= 0) return {};
  const completed = list.filter((todo) => todo && todo.status === 'completed').length;
  if (completed <= 0 || completed >= total) return {};
  const elapsed = now - started;
  if (elapsed < 3000) return {};
  const perTask = elapsed / completed;
  const remaining = (total - completed) * perTask;
  return {
    etaLow: Math.max(1000, Math.round(remaining * 0.6)),
    etaHigh: Math.max(2000, Math.round(remaining * 1.8)),
  };
}

/* Best-effort list of paths a shell command deletes (rm / unlink / rmdir /
   git rm). Deliberately conservative: only simple, unseparated invocations
   are recognised so we never mislabel a mutation as a deletion. */
export function parseDeletedPaths(command) {
  if (typeof command !== 'string' || !command.trim()) return [];
  const deleted = new Set();
  for (const segment of command.split(/\s*(?:&&|\|\||;|\n)\s*/)) {
    const tokens = segment.trim().split(/\s+/);
    if (!tokens.length) continue;
    let index = 0;
    if (tokens[0] === 'git' && tokens[1] === 'rm') index = 2;
    else if (tokens[0] === 'rm' || tokens[0] === 'unlink' || tokens[0] === 'rmdir') index = 1;
    else continue;
    for (; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (!token || token.startsWith('-')) continue;
      if (/[|&<>`$()*?{}\[\]"']/.test(token)) continue;
      deleted.add(token);
    }
  }
  return [...deleted];
}

export function textOf(result) {
  const content = result && Array.isArray(result.content) ? result.content : [];
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

export function countLines(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  return text.split('\n').length;
}

export function countPatch(patch) {
  const counts = { additions: 0, deletions: 0 };
  if (typeof patch !== 'string') return counts;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) counts.additions += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) counts.deletions += 1;
  }
  return counts;
}

export function extractExitCode(text, isError) {
  if (!isError) return 0;
  const match = /Command exited with code (\d+)/.exec(typeof text === 'string' ? text : '');
  return match ? Number(match[1]) : undefined;
}

function clip(value, max = 200) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/* Diffs ride along on typed tool events for the UI cards, but must not bloat
   the durable event log; cap them so the full patch stays in the tool artifact
   / worktree diff endpoint. */
export function capDiff(patch, max = 120000) {
  if (typeof patch !== 'string') return patch;
  return patch.length > max ? `${patch.slice(0, max)}\n… diff truncated (${patch.length - max} more characters)` : patch;
}

export function writeChange(path, preImage, content) {
  const exists = !!preImage && typeof preImage.content === 'string';
  if (!exists) {
    const patch = generateUnifiedPatch(path || 'file', '', content || '');
    return { change: 'created', additions: countLines(content), deletions: 0, diff: patch };
  }
  const patch = generateUnifiedPatch(path, preImage.content, content || '');
  return { change: 'modified', ...countPatch(patch), diff: patch };
}

export function summarizeTool({ toolName, args, result, isError, preImage }) {
  const toolKind = classifyTool(toolName);
  const path = pathArg(args);
  const command = commandArg(args);
  const details = result && result.details && typeof result.details === 'object' ? result.details : {};
  const text = textOf(result);
  const summary = { toolKind, path, status: isError ? 'error' : 'completed' };
  if (toolName === 'bash') summary.exitCode = extractExitCode(text, isError);
  if (toolName === 'grep' || toolName === 'find' || toolName === 'ls') {
    const lines = text ? text.split('\n').filter(Boolean).length : 0;
    summary.summary = lines ? `${lines} result(s)${path ? ` in ${path}` : ''}` : 'No results';
    return summary;
  }
  if (toolName === 'read') {
    summary.summary = path ? `Read ${path}` : 'Read file';
    return summary;
  }
  if (toolName === 'edit') {
    const counts = countPatch(details.patch);
    const patch = typeof details.patch === 'string' ? details.patch : typeof details.diff === 'string' ? details.diff : undefined;
    summary.additions = counts.additions;
    summary.deletions = counts.deletions;
    summary.diff = capDiff(patch);
    summary.summary = `${path || 'file'} +${counts.additions} -${counts.deletions}`;
    return summary;
  }
  if (toolName === 'write') {
    const change = writeChange(path, preImage, args && typeof args.content === 'string' ? args.content : '');
    summary.change = change.change;
    summary.additions = change.additions;
    summary.deletions = change.deletions;
    summary.diff = capDiff(change.diff);
    summary.summary = `${path || 'file'} ${change.change} +${change.additions} -${change.deletions}`;
    return summary;
  }
  if (toolName === 'bash') {
    const code = summary.exitCode;
    summary.summary = isError
      ? `exit ${code === undefined ? 'error' : code}${command ? `: ${clip(command, 100)}` : ''}`
      : `exit 0${command ? `: ${clip(command, 100)}` : ''}`;
    return summary;
  }
  if (toolName === 'test') {
    summary.passed = Number(details.passed) || 0;
    summary.failed = Number(details.failed) || 0;
    summary.summary = details.summary || `tests: ${summary.passed} passed, ${summary.failed} failed`;
    return summary;
  }
  if (toolName === 'todo') {
    summary.summary = details.summary || 'Todos updated';
    return summary;
  }
  if (toolName === 'ask_user') {
    summary.summary = details.answer === null ? 'Question cancelled' : 'Question answered';
    return summary;
  }
  summary.summary = text ? clip(text.split('\n')[0]) : toolName;
  return summary;
}

export function usageEvent(usage, extra = {}) {
  if (!usage) return undefined;
  return {
    kind: 'usage.updated',
    input: usage.input || 0,
    output: usage.output || 0,
    cacheRead: usage.cacheRead || 0,
    cacheWrite: usage.cacheWrite || 0,
    reasoning: usage.reasoning || 0,
    totalTokens: usage.totalTokens || 0,
    cost: usage.cost && typeof usage.cost === 'object' ? usage.cost.total || 0 : Number(usage.cost) || 0,
    ...extra,
  };
}

export function toolTitle(toolName, args) {
  const path = pathArg(args);
  const command = commandArg(args);
  switch (toolName) {
    case 'read':
      return path ? `read ${path}` : 'read';
    case 'grep':
      return `search ${clip(args && args.pattern, 60) || ''}${path ? ` in ${path}` : ''}`.trim();
    case 'find':
      return `find ${clip(args && args.pattern, 60) || ''}`.trim();
    case 'ls':
      return path ? `list ${path}` : 'list';
    case 'edit':
    case 'write':
      return `${toolName} ${path || ''}`.trim();
    case 'bash':
      return `run ${clip(command, 120) || ''}`.trim();
    case 'git':
      return `git ${args && args.action ? args.action : ''}`.trim();
    case 'test':
      return `test ${clip(args && args.command, 80) || ''}`.trim();
    case 'todo':
      return 'update plan';
    case 'ask_user':
      return 'ask user';
    default:
      return toolName;
  }
}
