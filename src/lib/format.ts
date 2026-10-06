import type { Message } from '@/lib/types';

export function messageText(message: Message) {
  return message.parts.filter((part) => part.type === 'text').map((part) => part.text || '').join('\n');
}

export function isActivity(message: Message) {
  return message.info.role === 'assistant'
    && !messageText(message).trim()
    && message.parts.some((part) => ['tool', 'step-start', 'step-finish', 'reasoning'].includes(part.type));
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
