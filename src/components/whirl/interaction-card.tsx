import { useState } from 'react';
import { mutate } from '@/lib/workbench';
import type { Interaction } from '@/lib/types';

export function InteractionCard({ interaction, onDone, onError }: { interaction: Interaction; onDone: () => void; onError: (error: string) => void }) {
  const [answers, setAnswers] = useState<string[][]>((interaction.questions || []).map(() => []));
  const [busy, setBusy] = useState(false);
  async function respond(body: unknown) { setBusy(true); try { await mutate(`/interactions/${interaction.id}`, body); onDone(); } catch (e) { onError((e as Error).message); } finally { setBusy(false); } }
  return <div className="mb-3 rounded-2xl border border-border bg-well p-4 text-sm" role="group" aria-label="Agent needs your input">
    {interaction.kind === 'permission' ? <><p className="font-medium">Allow {interaction.permission}?</p><p className="mt-1 break-all text-xs text-muted-foreground">{interaction.patterns?.join(', ')}</p><div className="mt-3 flex gap-2">{[['once', 'Allow once'], ['always', 'Allow for session'], ['reject', 'Deny']].map(([reply, label]) => <button key={reply} disabled={busy} onClick={() => void respond({ reply })} className="rounded-full bg-accent px-3 py-1.5 disabled:opacity-40">{label}</button>)}</div></> : <>
      {interaction.questions?.map((q, i) => <fieldset key={i} className="mb-3"><legend className="mb-2 font-medium">{q.question}</legend><div className="flex flex-wrap gap-2">{q.options.map(option => <label key={option.label} className="flex cursor-pointer items-center gap-2 rounded-xl bg-background p-2 text-xs"><input type={q.multiple ? 'checkbox' : 'radio'} name={`${interaction.id}-${i}`} checked={answers[i]?.includes(option.label) || false} onChange={() => setAnswers(old => old.map((a, n) => n === i ? q.multiple ? a.includes(option.label) ? a.filter(x => x !== option.label) : [...a, option.label] : [option.label] : a))} />{option.label}</label>)}</div><input placeholder="Or type an answer…" aria-label={`Custom answer: ${q.question}`} className="mt-2 w-full rounded-lg bg-background p-2 text-xs" onChange={e => setAnswers(old => old.map((a, n) => n === i ? [e.target.value] : a))} /></fieldset>)}
      <div className="flex gap-2"><button disabled={busy || answers.some(a => !a.length || !a[0])} onClick={() => void respond({ answers })} className="rounded-full bg-primary px-3 py-1.5 text-primary-foreground disabled:opacity-40">Send answer</button><button disabled={busy} onClick={() => void respond({ reject: true })}>Skip</button></div>
    </>}
  </div>;
}
