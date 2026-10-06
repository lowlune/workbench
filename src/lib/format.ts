import type { Message } from '@/lib/types';

export function titleCase(value?: string | null) {
  if (!value) return '';
  return value.replace(/[-_]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function statusLabel(status?: string) {
  return ({
    working: 'Thinking',
    blocked: 'Needs your attention',
    idle: 'Ready',
    done: 'Ready',
    history: 'Saved history',
    unknown: 'Online',
  } as Record<string, string>)[status || ''] || 'Conversation';
}

export function messageText(message: Message) {
  return message.parts.filter((part) => part.type === 'text').map((part) => part.text || '').join('\n');
}

export function isActivity(message: Message) {
  return message.info.role === 'assistant'
    && !messageText(message).trim()
    && message.parts.some((part) => ['tool', 'step-start', 'step-finish', 'reasoning'].includes(part.type));
}

export function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

export function formatTokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export function messageContext(message: Message) {
  const info = message.info;
  const usage = info.tokens;
  const used = Number(usage?.input || 0) + Number(usage?.cache?.read || 0) + Number(usage?.cache?.write || 0);
  const limit = Number(info.contextLimit || 0);
  const percent = limit > 0 && used > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return { used, limit, percent, output: Number(usage?.output || 0) };
}
