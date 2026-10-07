import type { MessagePart } from '@/lib/types';

/* Structured tool taxonomy for the thread. The control plane may emit either
   legacy `tool` parts (Pi's read/edit/bash/...) or new typed parts from the
   §4 event contract (`file.read`, `file.changed`, `command`, `test`, `git`,
   `todo`). Both are normalised here so the renderer never shows raw payloads
   in the normal flow. */

export type ToolStatus = string;

export interface TodoItem {
  id?: string;
  text?: string;
  status?: string;
}

export interface FileChangeView {
  kind: 'file-changed';
  id: string;
  status: ToolStatus;
  path: string;
  change: 'created' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
}

export interface FileReadView { kind: 'file-read'; id: string; status: ToolStatus; path: string; listing: boolean }
export interface FileSearchView { kind: 'file-search'; id: string; status: ToolStatus; query: string }
export interface CommandView {
  kind: 'command';
  id: string;
  status: ToolStatus;
  command: string;
  exitCode: number | null;
  output: string;
}
export interface TestView {
  kind: 'test';
  id: string;
  status: ToolStatus;
  passed: number;
  failed: number;
  summary: string;
  output: string;
}
export interface GitFileChange { path: string; additions: number; deletions: number }
export interface GitView {
  kind: 'git';
  id: string;
  status: ToolStatus;
  summary: string;
  files: GitFileChange[];
  output: string;
}
export interface TodoView { kind: 'todo'; id: string; status: ToolStatus; todos: TodoItem[] }
export interface GenericView {
  kind: 'generic';
  id: string;
  status: ToolStatus;
  tool: string;
  title: string;
  input?: unknown;
  output: string;
  error: string;
  artifactId?: string;
}

export type ToolView =
  | FileChangeView
  | FileReadView
  | FileSearchView
  | CommandView
  | TestView
  | GitView
  | TodoView
  | GenericView;

const TOOL_TYPES = new Set([
  'tool', 'file.read', 'file.search', 'file.changed',
  'command', 'test', 'git', 'todo', 'todo.updated', 'git.diff.updated',
]);

/** True for any part the thread should render through the tool pipeline. */
export function isToolPart(part: MessagePart) {
  return TOOL_TYPES.has(String(part.type || '').toLowerCase());
}

/** Tool parts, deduped by call id — a streamed/patched call must appear once. */
export function uniqueToolParts(parts: MessagePart[]): MessagePart[] {
  const seen = new Set<string>();
  const output: MessagePart[] = [];
  for (const part of parts) {
    if (!isToolPart(part)) continue;
    const key = String(part.callID || part.id || '');
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    output.push(part);
  }
  return output;
}

type RawPart = MessagePart & Record<string, unknown>;

function str(value: unknown): string {
  if (typeof value === 'string') return value;
  return value === undefined || value === null ? '' : String(value);
}

function num(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function pathOf(input: Record<string, unknown>, raw: RawPart, state: Record<string, unknown>) {
  return str(input.path || input.file_path || input.filePath || input.file || raw.path || state.path);
}

function changeKind(raw: RawPart, state: Record<string, unknown>, input: Record<string, unknown>, tool: string): FileChangeView['change'] {
  const declared = str(raw.change || state.change || input.change || raw.kind).toLowerCase();
  if (declared.includes('creat')) return 'created';
  if (declared.includes('delet') || declared.includes('remov')) return 'deleted';
  if (declared === 'modified' || declared === 'changed' || declared === 'edit') return 'modified';
  if (tool === 'write' || tool === 'create') return 'created';
  if (tool === 'delete' || tool === 'remove') return 'deleted';
  return 'modified';
}

function normalizeTodos(value: unknown): TodoItem[] {
  return list(value).map((entry) => {
    if (entry && typeof entry === 'object') {
      const item = entry as Record<string, unknown>;
      return { id: str(item.id) || undefined, text: str(item.text || item.title || item.content), status: str(item.status) || undefined };
    }
    return { text: str(entry) };
  }).filter((item) => item.text);
}

export function classifyPart(part: MessagePart): ToolView {
  const raw = part as RawPart;
  const state = obj(raw.state);
  const input = obj(state.input);
  const type = str(raw.type).toLowerCase();
  const kind = str(raw.kind || state.kind).toLowerCase();
  const tool = str(raw.tool || input.tool).toLowerCase();
  const status = str(state.status || raw.status || 'done').toLowerCase();
  const title = str(state.title || raw.title || raw.summary || state.summary);
  const summary = str(raw.summary || state.summary || title);
  const output = str(state.output || raw.output || '');
  const path = pathOf(input, raw, state);
  const id = part.id || `${type}_${tool}_${path}`;

  const rawTodos = list(raw.todos).length ? list(raw.todos) : list(state.todos).length ? list(state.todos) : list(input.todos);

  /* Legacy `tool` parts keep their input/output in the artifact store only.
     Without a structured payload there is nothing to render inline, so fall
     back to the lazy details card rather than an empty file/command row. */
  const opaqueLegacy = type === 'tool'
    && state.input === undefined
    && !output
    && Boolean(part.artifactId)
    && !rawTodos.length
    && num(raw.additions ?? state.additions) === null;
  if (opaqueLegacy) {
    return {
      kind: 'generic',
      id,
      status,
      tool: str(raw.tool || 'Tool'),
      title,
      output: '',
      error: str(state.error || raw.error),
      artifactId: part.artifactId,
    };
  }

  if (type === 'todo' || type === 'todo.updated' || kind.startsWith('todo') || rawTodos.length) {
    return { kind: 'todo', id, status, todos: normalizeTodos(rawTodos) };
  }

  if (type === 'test' || kind === 'test' || tool === 'test') {
    const passed = num(raw.passed ?? state.passed ?? input.passed) ?? 0;
    const failed = num(raw.failed ?? state.failed ?? input.failed) ?? 0;
    return { kind: 'test', id, status, passed, failed, summary, output };
  }

  if (type === 'git' || type === 'git.diff.updated' || kind === 'git' || kind === 'git.diff.updated' || tool === 'git') {
    const files = list(raw.files || state.files || input.files).map((entry) => {
      const file = obj(entry);
      return {
        path: str(file.path || file.file),
        additions: num(file.additions) ?? 0,
        deletions: num(file.deletions) ?? 0,
      };
    }).filter((file) => file.path);
    return { kind: 'git', id, status, summary, files, output };
  }

  if (type === 'command' || kind.includes('command') || tool === 'bash' || tool === 'shell') {
    const command = str(input.command || input.cmd || raw.command || state.command || summary);
    const exitCode = num(state.exitCode ?? state.exit_code ?? raw.exitCode ?? input.exitCode);
    return { kind: 'command', id, status, command, exitCode, output };
  }

  const explicitChange = type === 'file.changed' || kind === 'file.changed';
  if (explicitChange || (['edit', 'write', 'patch', 'multiedit'].includes(tool) && (path || num(raw.additions ?? state.additions) !== null))) {
    return {
      kind: 'file-changed',
      id,
      status,
      path: path || title,
      change: changeKind(raw, state, input, tool),
      additions: num(raw.additions ?? state.additions ?? input.additions) ?? 0,
      deletions: num(raw.deletions ?? state.deletions ?? input.deletions) ?? 0,
    };
  }

  if (type === 'file.read' || kind === 'file.read' || ((tool === 'read' || tool === 'ls' || tool === 'list') && (path || title))) {
    return { kind: 'file-read', id, status, path: path || title, listing: tool === 'ls' || tool === 'list' };
  }

  const searchQuery = str(input.query || input.pattern || summary || path);
  if (type === 'file.search' || kind === 'file.search' || (['grep', 'find', 'search', 'glob'].includes(tool) && searchQuery)) {
    return { kind: 'file-search', id, status, query: searchQuery };
  }

  return {
    kind: 'generic',
    id,
    status,
    tool: str(raw.tool || type || 'Tool'),
    title,
    input: state.input ?? raw.input,
    output,
    error: str(state.error || raw.error),
    artifactId: part.artifactId,
  };
}

/** A short human line for the collapsed activity summary. */
export function toolHeadline(view: ToolView): string {
  switch (view.kind) {
    case 'file-changed': return `${view.change === 'created' ? 'Created' : view.change === 'deleted' ? 'Deleted' : 'Changed'} ${view.path}`;
    case 'file-read': return view.listing ? `Listed ${view.path}` : `Read ${view.path}`;
    case 'file-search': return `Searched “${view.query}”`;
    case 'command': return `Ran ${view.command}`;
    case 'test': return view.failed > 0 ? `${view.failed} test${view.failed === 1 ? '' : 's'} failed` : 'Tests passed';
    case 'git': return view.summary || 'Git changes';
    case 'todo': return 'Updated plan';
    default: return view.title || view.tool;
  }
}
