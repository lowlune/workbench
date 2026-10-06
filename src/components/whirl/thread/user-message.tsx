import { useState } from 'react';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import { MessageActionButton } from '@/components/whirl/message-action-button';
import type { Message } from '@/lib/types';
import { messageText } from '@/lib/format';

/* One user turn: attachments up top, then the prompt in Whirl's well-toned
   capsule hugging the right edge. Plain text on purpose — prompts aren't
   markdown. */
export function UserMessage({ message }: { message: Message }) {
  const text = messageText(message);
  const files = message.parts.filter((part) => part.type === 'file');
  return (
    <div className="group/msg flex min-w-0 flex-col items-end gap-2">
      {files.length > 0 && (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-2">
          {files.map((part) => (
            part.mime?.startsWith('image/') && part.url
              ? (
                <a key={part.id} href={part.url} target="_blank" rel="noreferrer" className="block">
                  <img src={part.url} alt={part.filename || 'Attached image'} className="max-h-64 max-w-full rounded-2xl object-contain shadow-[inset_0_0_0_1px_var(--well-outline)]" loading="lazy" />
                </a>
              )
              : <span key={part.id} className="rounded-full bg-well px-3 py-1.5 text-[13px] text-muted-foreground shadow-[inset_0_0_0_1px_var(--well-outline)]">{part.filename || 'Attached file'}</span>
          ))}
        </div>
      )}
      {text.length > 0 && (
        <div className="min-w-0 max-w-[85%] rounded-[20px] rounded-br-md bg-well px-3.5 py-2 text-[15px]/6 break-words whitespace-pre-wrap [overflow-wrap:anywhere] shadow-[inset_0_0_0_1px_var(--well-outline),inset_0_1px_0_0_var(--well-highlight)]">
          {text}
        </div>
      )}
      {text.length > 0 && (
        <div className="-mt-1 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/msg:opacity-100 focus-within:opacity-100 coarse:opacity-100">
          <CopyAction text={text} />
        </div>
      )}
    </div>
  );
}

function CopyAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <MessageActionButton
      label="Copy message"
      tooltip={copied ? 'Copied' : 'Copy message'}
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        }).catch(() => {});
      }}
    >
      {copied ? <IconCheck size={15} /> : <IconCopy size={15} />}
    </MessageActionButton>
  );
}
