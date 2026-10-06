import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Attachment } from '@/lib/attachments';
import { localRead, localWrite, mutate } from '@/lib/workbench';
import type { Message, Project, Session } from '@/lib/types';
import { Composer } from '@/components/whirl/composer';
import ContextLibrary from '@/components/whirl/pages/context-library';
import { ProjectFilesDialog } from '@/components/whirl/project-files-dialog';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';

type Draft = { text: string; attachments: Attachment[] };
type Intent = {
  id: string;
  conversationId: string;
  create?: { id: string; title: string; engine: string; projectId: string | null; model: string; mode: string; workspace?: string };
  text: string;
  attachmentIds: string[];
  model: string;
  reasoning?: string | null;
};

const emptyDraft = (): Draft => ({ text: '', attachments: [] });

/* The composer owns drafts, pending intents and the attachment sources.
   Sending is optimistic: the user message is rendered immediately and the
   durable command carries the same ID, so a reload or retry never posts
   the message twice. */
export function Editor({
  draftKey,
  session,
  engine,
  model,
  reasoning,
  mode,
  workspace,
  projects,
  project,
  projectId,
  onNavigate,
  onToast,
  working,
  onStop,
}: {
  draftKey: string;
  session?: Session;
  engine: 'opencode' | 'pi';
  model: string;
  reasoning?: string | null;
  mode: string;
  workspace?: string;
  projects: Project[];
  project?: Project;
  projectId?: string | null;
  onNavigate: (id: string) => void;
  onToast: (text: string, error?: boolean) => void;
  working: boolean;
  onStop: () => void;
}) {
  const client = useQueryClient();
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [loaded, setLoaded] = useState(false);
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<Intent>();
  const [library, setLibrary] = useState(false);
  const [files, setFiles] = useState(false);
  const latest = useRef(draft);
  latest.current = draft;
  const busy = useRef(false);
  useEffect(() => {
    let disposed = false;
    Promise.all([localRead<Draft>(`draft:${draftKey}`), localRead<Intent>(`pending:${draftKey}`)])
      .then(([saved, intent]) => { if (!disposed) { setDraft(saved || emptyDraft()); setPending(intent); setLoaded(true); } })
      .catch(() => { if (!disposed) { setLoaded(true); onToast('Local storage is unavailable. Keep this tab open until your message is accepted.', true); } });
    return () => { disposed = true; };
  }, [draftKey]);
  useEffect(() => { const handler = (event: Event) => update({ ...latest.current, text: (event as CustomEvent<string>).detail }); window.addEventListener('workbench-suggestion', handler); return () => window.removeEventListener('workbench-suggestion', handler); }, [draftKey]);

  function update(value: Draft) {
    setDraft(value);
    latest.current = value;
    void localWrite(`draft:${draftKey}`, value).catch(() => {});
  }

  async function send(retry?: Intent) {
    if (busy.current) return;
    const snapshot = latest.current;
    if (!retry && !model) { onToast('Choose a connected model first.', true); return; }
    if (!retry && snapshot.attachments.some((attachment) => !attachment.id)) { onToast('Reattach this file so it can be uploaded.', true); return; }
    const id = retry?.conversationId || session?.id || `chat_${crypto.randomUUID()}`;
    const intent: Intent = retry || {
      id: crypto.randomUUID(),
      conversationId: id,
      ...(session ? {} : { create: { id, title: snapshot.text.slice(0, 80) || 'Image conversation', engine, projectId: projectId || null, model, mode, workspace } }),
      text: snapshot.text,
      attachmentIds: snapshot.attachments.map((attachment) => attachment.id!),
      model,
      reasoning,
    };
    busy.current = true;
    setSending(true);
    setPending(intent);
    try {
      await localWrite(`pending:${draftKey}`, intent);
      if (intent.create) {
        const result = await mutate<{ session: Session }>('/conversations', intent.create);
        client.setQueryData(['conversation', id], { session: { ...result.session, messages: [] } });
      }
      const message: Message = {
        id: `user_${intent.id}`,
        commandId: intent.id,
        created: Date.now(),
        info: { role: 'user' },
        parts: [{ id: intent.id, type: 'text', text: intent.text }, ...snapshot.attachments.map((attachment) => ({ id: attachment.id!, type: 'file', mime: attachment.mime, filename: attachment.name, url: attachment.dataUrl }))],
      };
      client.setQueryData<{ session: Session }>(['conversation', id], (current) => current ? { session: merge(current.session, { id, messages: [message] }) } : current);
      await mutate(`/conversations/${id}/commands`, { clientCommandId: intent.id, text: intent.text, attachmentIds: intent.attachmentIds, model: intent.model, reasoning: intent.reasoning });
      await localWrite(`pending:${draftKey}`, undefined);
      setPending(undefined);
      if (latest.current.text === snapshot.text && latest.current.attachments === snapshot.attachments && snapshot.text === intent.text && JSON.stringify(snapshot.attachments.map((attachment) => attachment.id)) === JSON.stringify(intent.attachmentIds)) update(emptyDraft());
      await client.invalidateQueries({ queryKey: ['conversation', id] });
      void client.invalidateQueries({ queryKey: ['bootstrap'] });
      onNavigate(id);
    } catch (error) {
      onToast((error as Error).message, true);
    } finally {
      busy.current = false;
      setSending(false);
    }
  }

  function addAttachment(attachment: Attachment) {
    if (latest.current.attachments.length >= 4) { onToast('Attach up to four files.', true); return; }
    update({ ...latest.current, attachments: [...latest.current.attachments, attachment] });
  }

  return (
    <>
      {pending && !sending && (
        <div className="mb-2 rounded-xl bg-well p-3 text-xs">
          <p>Message delivery needs confirmation. Retrying uses the same command ID.</p>
          <div className="mt-2 flex gap-3">
            <button className="font-medium underline" onClick={() => void send(pending)}>Check / retry safely</button>
            <button onClick={() => { void localWrite(`pending:${draftKey}`, undefined); setPending(undefined); }}>Dismiss</button>
          </div>
        </div>
      )}
      <Composer
        draft={draft.text}
        attachments={draft.attachments}
        onDraftChange={(text) => update({ ...latest.current, text })}
        onAttachmentsChange={(attachments) => update({ ...latest.current, attachments })}
        onSend={() => send()}
        sending={sending || !!pending}
        disabled={!loaded}
        isGenerating={working}
        onStop={onStop}
        placeholder={working ? 'Add a follow-up — it will wait for this task…' : 'Ask anything…'}
        onToast={onToast}
        onOpenLibrary={() => setLibrary(true)}
        onOpenProjectFiles={project ? () => setFiles(true) : undefined}
      />
      <Dialog open={library} onOpenChange={setLibrary}>
        <DialogContent className="h-[80dvh] max-w-3xl overflow-hidden p-0">
          <DialogTitle className="sr-only">Attach saved context</DialogTitle>
          <DialogDescription className="sr-only">Choose context from this project or General.</DialogDescription>
          <ContextLibrary
            projects={projects}
            projectId={projectId}
            onToast={onToast}
            onUse={(text, attachment) => {
              if (attachment && latest.current.attachments.length >= 4) { onToast('Attach up to four files.', true); return; }
              update({ text: [latest.current.text, text].filter(Boolean).join('\n\n'), attachments: attachment ? [...latest.current.attachments, attachment] : latest.current.attachments });
              setLibrary(false);
            }}
          />
        </DialogContent>
      </Dialog>
      <ProjectFilesDialog project={project} open={files} onOpenChange={setFiles} onPick={(attachment) => { addAttachment(attachment); setFiles(false); }} onToast={onToast} />
    </>
  );
}

function merge(previous: Session | undefined, next: Session): Session {
  if (!previous) return next;
  const messages = new Map((previous.messages || []).map((message) => [message.id, message]));
  for (const message of next.messages || []) messages.set(message.id, message);
  return {
    ...previous,
    ...next,
    hasMoreMessages: previous.hasMoreMessages,
    messages: [...messages.values()].sort((a, b) => (a.created || 0) - (b.created || 0) || a.id.localeCompare(b.id)),
  };
}
