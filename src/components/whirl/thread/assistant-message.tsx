import { memo, useState } from 'react';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import { Markdown } from '@/components/whirl/markdown';
import { MessageActionButton } from '@/components/whirl/message-action-button';
import { ToolActivity } from '@/components/whirl/thread/activity';
import { SystemMessage, normalText, systemTexts } from '@/components/whirl/thread/system-message';
import { isToolPart } from '@/components/whirl/thread/tool-data';
import { formatTokens, messageContext } from '@/lib/format';
import type { FileRef } from '@/components/whirl/file-viewer';
import type { Message } from '@/lib/types';
import { cn } from '@/lib/utils';

/* One assistant turn: prose first, tool runs beneath it, then the quiet
   action row (copy + usage stats) that fades in on hover. System notices
   (model switches) sit centered between turns. */
export const AssistantMessage = memo(function AssistantMessage({
  message,
  isWorking,
  onOpenFile,
}: {
  message: Message;
  isWorking: boolean;
  onOpenFile?: (file: FileRef) => void;
}) {
  const text = normalText(message);
  const notices = systemTexts(message);
  const tools = message.parts.filter(isToolPart);
  const context = messageContext(message);
  const model = message.info.modelName || message.info.modelID;
  const hasStats = Boolean(model || context.used || context.output);

  if (!text && !tools.length && !notices.length) return null;

  return (
    <div className="group/msg flex w-full min-w-0 flex-col items-start">
      {notices.map((notice, index) => <SystemMessage key={index} text={notice} />)}
      {text.length > 0 && <Markdown>{text}</Markdown>}
      {tools.length > 0 && (
        <div className={cn('w-full min-w-0', text.length > 0 && 'mt-1.5')}>
          <ToolActivity tools={tools} running={isWorking} onOpenFile={onOpenFile} />
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
