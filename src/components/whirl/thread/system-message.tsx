import { IconInfoCircle } from '@tabler/icons-react';
import type { Message, MessagePart } from '@/lib/types';

/* Quiet, centered system notices — model switches and other control-plane
   events that belong in the transcript without looking like a turn. */

const MODEL_CHANGE = /^model changed\b/i;

export function isSystemPart(part: MessagePart) {
  const type = String(part.type || '').toLowerCase();
  if (type === 'system' || type === 'model.changed') return true;
  return type === 'text' && MODEL_CHANGE.test((part.text || '').trim());
}

export function systemPartText(part: MessagePart) {
  return (part.text || '').trim();
}

export function systemTexts(message: Message) {
  return (message.parts || []).filter(isSystemPart).map(systemPartText).filter(Boolean);
}

export function normalText(message: Message) {
  return (message.parts || []).filter((part) => part.type === 'text' && !isSystemPart(part)).map((part) => part.text || '').join('\n');
}

export function SystemMessage({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-1 text-[12px] text-muted-foreground">
      <span aria-hidden="true" className="h-px w-6 bg-border" />
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <IconInfoCircle size={13} className="shrink-0" />
        <span className="truncate">{text}</span>
      </span>
      <span aria-hidden="true" className="h-px w-6 bg-border" />
    </div>
  );
}
