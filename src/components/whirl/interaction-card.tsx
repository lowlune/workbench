import { useState } from 'react';
import { IconAlertTriangleFilled, IconHelpCircle, IconLoader2 } from '@tabler/icons-react';
import { mutate } from '@/lib/workbench';
import type { Interaction } from '@/lib/types';
import { cn } from '@/lib/utils';

/* Agent input gates: a permission approval or a structured question. Both
   block the Run, so they sit above the composer with a loud waiting header
   and answer through the existing `/interactions/:id` endpoint. */
export function InteractionCard({ interaction, onDone, onError }: { interaction: Interaction; onDone: () => void; onError: (error: string) => void }) {
  const questions = interaction.questions || [];
  const [selected, setSelected] = useState<string[][]>(() => questions.map(() => []));
  const [custom, setCustom] = useState<string[]>(() => questions.map(() => ''));
  const [busy, setBusy] = useState(false);

  async function respond(body: unknown) {
    setBusy(true);
    try {
      await mutate(`/interactions/${interaction.id}`, body);
      onDone();
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Could not send your response.');
    } finally {
      setBusy(false);
    }
  }

  function toggle(questionIndex: number, label: string, multiple: boolean) {
    setSelected((current) => current.map((answer, index) => {
      if (index !== questionIndex) return answer;
      if (!multiple) return answer.includes(label) ? [] : [label];
      return answer.includes(label) ? answer.filter((value) => value !== label) : [...answer, label];
    }));
  }

  const answers = questions.map((_, index) => {
    const values = [...(selected[index] || [])];
    const extra = (custom[index] || '').trim();
    if (extra) values.push(extra);
    return values;
  });
  const canSend = questions.length > 0 && answers.every((answer) => answer.length > 0);

  if (interaction.kind === 'permission') {
    return (
      <div className="mb-3 overflow-hidden rounded-2xl bg-well shadow-[inset_0_0_0_1px_var(--well-outline)]" role="group" aria-label="Permission required">
        <div className="flex items-center gap-2 bg-amber-500/10 px-3.5 py-2 text-[12px] font-medium text-amber-700 dark:text-amber-300">
          <IconAlertTriangleFilled size={14} className="shrink-0" />
          Permission required — the run is paused
        </div>
        <div className="p-3.5">
          <p className="text-[14px] font-medium">Allow <span className="font-mono text-[13px]">{interaction.permission || 'this action'}</span>?</p>
          {interaction.patterns && interaction.patterns.length > 0 && (
            <p className="mt-1.5 break-all font-mono text-[11px]/5 text-muted-foreground">{interaction.patterns.join('\n')}</p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" disabled={busy} onClick={() => void respond({ reply: 'once' })} className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-[13px] font-medium text-primary-foreground transition-[background-color,scale] duration-150 hover:bg-(--primary-hover) active:scale-[0.96] disabled:opacity-40">
              {busy && <IconLoader2 size={13} className="animate-spin" />}
              Allow
            </button>
            <button type="button" disabled={busy} onClick={() => void respond({ reply: 'always' })} className="cursor-pointer rounded-full bg-accent px-3.5 py-1.5 text-[13px] font-medium transition-colors duration-150 hover:bg-accent/70 disabled:opacity-40">
              Allow for this Run
            </button>
            <button type="button" disabled={busy} onClick={() => void respond({ reply: 'reject' })} className="cursor-pointer rounded-full px-3 py-1.5 text-[13px] font-medium text-destructive transition-colors duration-150 hover:bg-destructive/10 disabled:opacity-40">
              Deny
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-3 overflow-hidden rounded-2xl bg-well shadow-[inset_0_0_0_1px_var(--well-outline)]" role="group" aria-label="Agent question">
      <div className="flex items-center gap-2 bg-(--well-translucent) px-3.5 py-2 text-[12px] font-medium text-foreground">
        <IconHelpCircle size={14} className="shrink-0 text-muted-foreground" />
        The agent is waiting for your answer
      </div>
      <div className="p-3.5">
        {questions.map((question, questionIndex) => (
          <fieldset key={questionIndex} className={cn(questionIndex > 0 && 'mt-4')}>
            <legend className="text-[13px] font-medium">
              {question.header && <span className="mr-1.5 text-muted-foreground">{question.header}</span>}
              {question.question}
            </legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {(question.options || []).map((option) => {
                const checked = (selected[questionIndex] || []).includes(option.label);
                return (
                  <button
                    key={option.label}
                    type="button"
                    disabled={busy}
                    aria-pressed={checked}
                    onClick={() => toggle(questionIndex, option.label, Boolean(question.multiple))}
                    className={cn(
                      'max-w-full cursor-pointer rounded-xl px-3 py-2 text-left text-[13px] transition-colors duration-100 disabled:opacity-40',
                      checked
                        ? 'bg-primary/10 text-foreground shadow-[inset_0_0_0_1px_var(--primary)]'
                        : 'bg-background shadow-[inset_0_0_0_1px_var(--well-outline)] hover:bg-accent',
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <span className={cn(
                        'grid size-3.5 shrink-0 place-items-center border border-muted-foreground/50',
                        question.multiple ? 'rounded-[4px]' : 'rounded-full',
                        checked && 'border-primary bg-primary',
                      )}>
                        {checked && <span className={cn('size-1.5 bg-primary-foreground', question.multiple ? 'rounded-[2px]' : 'rounded-full')} />}
                      </span>
                      <span className="min-w-0">
                        <span className="block">{option.label}</span>
                        {option.description && <span className="mt-0.5 block text-[11px]/4 text-muted-foreground">{option.description}</span>}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            <input
              value={custom[questionIndex] || ''}
              disabled={busy}
              onChange={(event) => setCustom((current) => current.map((value, index) => index === questionIndex ? event.target.value : value))}
              placeholder={question.options?.length ? 'Or type your own answer…' : 'Type your answer…'}
              aria-label={`Custom answer: ${question.question}`}
              className="mt-2 w-full rounded-xl bg-background px-3 py-2 text-[13px] shadow-[inset_0_0_0_1px_var(--well-outline)] outline-none transition-shadow focus:shadow-[inset_0_0_0_1px_var(--primary)] disabled:opacity-40"
            />
          </fieldset>
        ))}
        <div className="mt-3.5 flex items-center gap-2">
          <button
            type="button"
            disabled={busy || !canSend}
            onClick={() => void respond({ answers })}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-[13px] font-medium text-primary-foreground transition-[background-color,scale] duration-150 hover:bg-(--primary-hover) active:scale-[0.96] disabled:opacity-40"
          >
            {busy && <IconLoader2 size={13} className="animate-spin" />}
            Send answer
          </button>
          <button type="button" disabled={busy} onClick={() => void respond({ reject: true })} className="cursor-pointer rounded-full px-3 py-1.5 text-[13px] text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground disabled:opacity-40">
            Skip
          </button>
        </div>
      </div>
    </div>
  );
}
