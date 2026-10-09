import { memo, useState } from 'react';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import { Markdown } from '@/components/whirl/markdown';
import { MessageActionButton } from '@/components/whirl/message-action-button';
import { ToolActivity } from '@/components/whirl/thread/activity';
import { SystemMessage, normalText, systemTexts } from '@/components/whirl/thread/system-message';
import { uniqueToolParts } from '@/components/whirl/thread/tool-data';
import { formatTokens, messageContext } from '@/lib/format';
import type { FileRef } from '@/components/whirl/file-viewer';
import type { Message, MessagePart } from '@/lib/types';
import { cn } from '@/lib/utils';

/* One assistant turn: prose first, tool runs beneath it, then the quiet
   action row (copy + usage stats) that fades in on hover. System notices
   (model switches) sit centered between turns. */
export const AssistantMessage = memo(function AssistantMessage({
  message,
  isWorking,
  onOpenFile,
  toolParts,
  hideTools = false,
}: {
  message: Message;
  isWorking: boolean;
  onOpenFile?: (file: FileRef) => void;
  /** Aggregated calls for this command, rendered once on its final assistant row. */
  toolParts?: MessagePart[];
  hideTools?: boolean;
}) {
  const text = normalText(message);
  const notices = systemTexts(message);
  const tools = hideTools ? [] : toolParts || uniqueToolParts(message.parts);
  const images = message.parts.filter((part) => part.type === 'file' && part.mime?.startsWith('image/') && part.url);
  const context = messageContext(message);
  const model = message.info.modelName || message.info.modelID;
  const hasStats = Boolean(model || context.used || context.output);

  if (!text && !tools.length && !notices.length && !images.length) return null;

  return (
    <div className="group/msg flex w-full min-w-0 flex-col items-start">
      {[...new Set(notices)].map((notice) => <SystemMessage key={notice} text={notice} />)}
      {text.length > 0 && <Markdown>{text}</Markdown>}
      {tools.length > 0 && (
        <div className={cn('w-full min-w-0', text.length > 0 && 'mt-1.5')}>
          <ToolActivity tools={tools} onOpenFile={onOpenFile} />
        </div>
      )}
      {images.length > 0 && (
        <div className={cn('flex w-full min-w-0 flex-wrap gap-2', (text.length > 0 || tools.length > 0) && 'mt-2')}>
          {images.map((part) => (
            <a key={part.id} href={part.url} target="_blank" rel="noreferrer" className="block max-w-full">
              <img
                src={part.url}
                alt={part.filename || 'Tool image'}
                loading="lazy"
                className="max-h-80 max-w-full rounded-xl object-contain shadow-[inset_0_0_0_1px_var(--well-outline)]"
              />
            </a>
          ))}
        </div>
      )}
      {!isWorking && text.length > 0 && (
        <div className="mt-1.5 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/msg:opacity-100 focus-within:opacity-100 coarse:opacity-100">
          <CopyAction text={text} />
          {hasStats && (
            <span className="flex items-center gap-1.5 pl-1.5 text-[11px] text-muted-foreground">
              {model && <span className="max-w-44 truncate">{model}</span>}
              {context.used > 0 && <span className="tabular-nums">{formatTokens(context.used)} in</span>}
              {context.output > 0 && <span className="tabular-nums">{formatTokens(context.output)} out</span>}
            </span>
          )}
        </div>
      )}
    </div>
  );
});

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
