import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { currentAction, estimateEta } from './events.mjs';
import { agentEnv, workspaceGuard } from '../security.mjs';

export const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls', 'todo', 'ask_user', 'git'];
export const BUILD_TOOLS = ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash', 'todo', 'ask_user', 'git', 'test'];

const TODO_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['write', 'list'], description: 'Replace the plan (write) or read it (list)' },
    todos: {
      type: 'array',
      description: 'Full plan; replaces the previous one',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Stable identifier' },
          text: { type: 'string', description: 'Task description' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
        },
        required: ['text', 'status'],
      },
    },
  },
};

const ASK_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      description: 'Questions to ask the user',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          header: { type: 'string' },
          question: { type: 'string' },
          multiple: { type: 'boolean' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                description: { type: 'string' },
              },
              required: ['label'],
            },
          },
        },
        required: ['question'],
      },
    },
  },
  required: ['questions'],
};

const GIT_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['status', 'diff', 'log'] },
    args: { type: 'array', items: { type: 'string' }, description: 'Extra git arguments' },
  },
  required: ['action'],
};

const TEST_SCHEMA = {
  type: 'object',
  properties: {
    command: { type: 'string', description: 'Test command; defaults to the project test script' },
    timeout: { type: 'number', description: 'Timeout in milliseconds' },
  },
};

function formatTodos(todos) {
  if (!todos.length) return 'No todos';
  return todos
    .map((todo) => `[${todo.status === 'completed' ? 'x' : todo.status === 'in_progress' ? '~' : ' '}] #${todo.id} ${todo.text}`)
    .join('\n');
}

function normalizeQuestions(input) {
  const list = Array.isArray(input) ? input : [];
  return list.map((question, index) => ({
    id: typeof question?.id === 'string' ? question.id : `q${index + 1}`,
    header: typeof question?.header === 'string' ? question.header : undefined,
    question: String(question?.question || 'Question'),
    multiple: !!question?.multiple,
    options: (Array.isArray(question?.options) ? question.options : [])
      .map((option) => (typeof option === 'string' ? { label: option } : { label: String(option?.label || ''), description: option?.description }))
      .filter((option) => option.label),
  }));
}

function runProcess(command, args, { cwd, shell = false, timeout = 600000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell, env: agentEnv() });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let killTimer;
    const onAbort = () => { child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 1000); killTimer.unref(); };
    const timer = timeout ? setTimeout(onAbort, Math.min(600000, Math.max(1, timeout))) : null;
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const append = (chunk, target) => {
      const value = target === 'out' ? stdout + chunk : stderr + chunk;
      if (target === 'out') stdout = value.length > 2_000_000 ? value.slice(-1_000_000) : value;
      else stderr = value.length > 2_000_000 ? value.slice(-1_000_000) : value;
    };
    child.stdout?.on('data', (chunk) => append(String(chunk), 'out'));
    child.stderr?.on('data', (chunk) => append(String(chunk), 'err'));
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      clearTimeout(killTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

function detectTestCommand(cwd) {
  const manifestPath = path.join(cwd, 'package.json');
  if (!existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const script = manifest.scripts?.test;
    if (typeof script !== 'string' || !script.trim() || /no test specified/i.test(script)) return null;
    if (existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm test';
    if (existsSync(path.join(cwd, 'yarn.lock'))) return 'yarn test';
    return 'npm test';
  } catch {
    return null;
  }
}

function parseNumstat(output) {
  const files = [];
  for (const line of String(output || '').split('\n')) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
    if (!match) continue;
    files.push({
      path: match[3],
      additions: match[1] === '-' ? 0 : Number(match[1]),
      deletions: match[2] === '-' ? 0 : Number(match[2]),
    });
  }
  return files;
}

function parseTests(output, exitCode) {
  const text = String(output || '');
  const jest = /Tests:\s+(\d+)\s+failed,\s+(\d+)\s+passed/.exec(text);
  if (jest) return { failed: Number(jest[1]), passed: Number(jest[2]) };
  const passedOnly = /Tests:\s+(\d+)\s+passed/.exec(text);
  const passing = /(\d+)\s+passing/.exec(text);
  const failing = /(\d+)\s+failing/.exec(text);
  if (passing || failing) return { passed: Number(passing?.[1] || 0), failed: Number(failing?.[1] || 0) };
  if (passedOnly) return { passed: Number(passedOnly[1]), failed: 0 };
  return { passed: exitCode === 0 ? 1 : 0, failed: exitCode === 0 ? 0 : 1 };
}

function permissionMode(state) {
  return state.permissionMode || 'dangerous';
}

export function needsPermission(state, event) {
  const mode = permissionMode(state);
  if (mode === 'off') return false;
  if (mode === 'all') {
    if (!['bash', 'test', 'edit', 'write'].includes(event.toolName)) return false;
    return !state.allowedTools.has(event.toolName);
  }
  // Legacy 'dangerous' means approve shell execution, not guess shell grammar.
  return ['bash', 'test'].includes(event.toolName) && !state.allowedTools.has(event.toolName);
}

export function createWorkbenchExtension(port) {
  return (pi) => {
    pi.on('tool_call', async (event) => {
      const guarded = workspaceGuard(port.cwd, event);
      if (guarded) return guarded;
      if (event.toolName === 'write' && typeof event.input?.path === 'string') {
        const full = path.resolve(port.cwd, event.input.path);
        try {
          port.preImages.set(event.toolCallId, { path: event.input.path, content: readFileSync(full, 'utf8') });
        } catch {
          port.preImages.set(event.toolCallId, { path: event.input.path, content: null });
        }
      }
      if (!needsPermission(port.state, event)) return undefined;
      const detail = event.toolName === 'bash' && typeof event.input?.command === 'string' ? event.input.command : event.input?.path || event.toolName;
      let reply;
      try {
        reply = await port.requestPermission({ action: event.toolName, detail, toolCallId: event.toolCallId });
      } catch (error) {
        return { block: true, reason: error?.message || `Permission request for ${event.toolName} was cancelled.` };
      }
      if (reply === 'reject' || reply === false) return { block: true, reason: `Permission denied for ${event.toolName}${detail ? `: ${detail}` : ''}.` };
      if (reply === 'always') port.state.allowedTools.add(event.toolName);
      return undefined;
    });

    pi.registerTool(
      defineTool({
        name: 'todo',
        label: 'Todo',
        description: 'Maintain the structured plan for the current run. Call with action="write" and the full list to replace it.',
        promptSnippet: 'Maintain a structured todo plan for multi-step work',
        promptGuidelines: ['Use todo to publish a concise plan before multi-step changes and keep statuses current.'],
        parameters: TODO_SCHEMA,
        executionMode: 'sequential',
        async execute(_toolCallId, params) {
          if (params.action === 'list') {
            const todos = port.state.todos.map((todo) => ({ ...todo }));
            return { content: [{ type: 'text', text: formatTodos(todos) }], details: { todos, summary: `${todos.length} todos` } };
          }
          const todos = (Array.isArray(params.todos) ? params.todos : []).map((todo, index) => ({
            id: String(todo?.id ?? index + 1),
            text: String(todo?.text || ''),
            status: ['pending', 'in_progress', 'completed'].includes(todo?.status) ? todo.status : 'pending',
          }));
          port.state.todos = todos;
          port.emit({ kind: 'todo.updated', todos, currentAction: currentAction('todo', {}), ...estimateEta(todos, port.state.startedAt) });
          const done = todos.filter((todo) => todo.status === 'completed').length;
          return {
            content: [{ type: 'text', text: formatTodos(todos) }],
            details: { todos, summary: `${done}/${todos.length} done` },
          };
        },
      }),
    );

    pi.registerTool(
      defineTool({
        name: 'ask_user',
        label: 'Ask user',
        description: 'Ask the user one or more questions and wait for their answer before continuing.',
        promptSnippet: 'Ask the user a blocking question with optional choices',
        promptGuidelines: ['Use ask_user only when a decision is genuinely ambiguous and blocking.'],
        parameters: ASK_SCHEMA,
        executionMode: 'sequential',
        async execute(_toolCallId, params) {
          const questions = normalizeQuestions(params.questions);
          if (!questions.length) {
            return { content: [{ type: 'text', text: 'Error: at least one question is required.' }], details: { answer: null } };
          }
          const answers = await port.requestQuestion(questions);
          if (answers === null || answers === undefined) {
            return { content: [{ type: 'text', text: 'User skipped the question.' }], details: { answer: null, questions } };
          }
          const text = questions
            .map((question, index) => `${question.question}\n${(answers[index] || []).join(', ') || '(no answer)'}`)
            .join('\n\n');
          return { content: [{ type: 'text', text }], details: { answers, answer: text, questions } };
        },
      }),
    );

    pi.registerTool(
      defineTool({
        name: 'git',
        label: 'Git',
        description: 'Read-only git status, diff, or log for the working tree.',
        promptSnippet: 'Inspect git status, diff, and log',
        parameters: GIT_SCHEMA,
        async execute(_toolCallId, params, signal) {
          const base = {
            status: ['status', '--short', '--branch'],
            diff: ['diff', '--numstat'],
            log: ['log', '--oneline', '-n', '20'],
          }[params.action];
          if (!base) return { content: [{ type: 'text', text: `Unknown git action: ${params.action}` }], details: { action: params.action } };
          const extra = (Array.isArray(params.args) ? params.args : []).map(String);
          const result = await runProcess('git', [...base, ...extra], { cwd: port.cwd, signal });
          const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
          const files = params.action === 'diff' ? parseNumstat(result.stdout) : [];
          if (files.length) port.emit({ kind: 'git.diff.updated', files, summary: `${files.length} file(s)` });
          return { content: [{ type: 'text', text: output || '(no output)' }], details: { action: params.action, files } };
        },
      }),
    );

    pi.registerTool(
      defineTool({
        name: 'test',
        label: 'Test',
        description: 'Run the project test suite and report structured pass/fail counts.',
        promptSnippet: 'Run the project test suite',
        promptGuidelines: ['Use test to verify changes before reporting completion.'],
        parameters: TEST_SCHEMA,
        executionMode: 'sequential',
        async execute(_toolCallId, params, signal) {
          const command = params.command || detectTestCommand(port.cwd);
          if (!command) {
            return { content: [{ type: 'text', text: 'No test command found. Pass one explicitly.' }], details: { passed: 0, failed: 0, summary: 'no test command' } };
          }
          const started = Date.now();
          const result = await runProcess(command, [], { cwd: port.cwd, shell: true, timeout: params.timeout || 600000, signal });
          const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
          const counts = parseTests(output, result.exitCode);
          const summary = `${counts.passed} passed, ${counts.failed} failed`;
          port.emit({ kind: 'test.completed', passed: counts.passed, failed: counts.failed, summary, command, durationMs: Date.now() - started });
          return { content: [{ type: 'text', text: output.slice(-40000) || summary }], details: { passed: counts.passed, failed: counts.failed, summary, exitCode: result.exitCode } };
        },
      }),
    );
  };
}
