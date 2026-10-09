# 007 — Give transient surfaces an entrance (and the run card an exit)

- **Status**: TODO
- **Commit**: f509488
- **Severity**: MEDIUM
- **Category**: Missed opportunity / preventing a jarring change
- **Estimated scope**: 3 files + CSS (`workbench.css`, `composer.tsx`, `chat-view.tsx`, `run-summary.tsx`, `interaction-card.tsx`), ~50 lines

## Problem

Several surfaces that the user is *looking at when they appear* pop in and out
with no bridge. Emil lists "content that appears or vanishes with no bridge"
as a valid purpose for motion; these are that case:

1. **Composer attachments** — picking/copying a file makes tiles materialise.
   ```tsx
   // src/components/whirl/composer.tsx:166 — current
   <div className="mb-1 flex flex-wrap gap-2 px-1 pt-1" aria-label="Attached files">
   ```
2. **Queued-messages card** — appears above the composer when messages queue.
   ```tsx
   // src/components/whirl/chat-view.tsx:~410 — current
   <div role="status" className="mb-2 rounded-3xl border border-[var(--well-outline)] bg-(--well-translucent) px-3 py-2.5 text-[12px] backdrop-blur-xl">
   ```
3. **Run summary** — appears when a run starts and vanishes when it expires.
   ```tsx
   // src/components/whirl/run-summary.tsx:~154 — current root
   <div role="status" className={cn('mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-3xl border ...')}>
   ...
   if (expired) return null;   // abrupt removal
   ```
4. **Interaction cards** (permission / question) — they block the run and are
   the highest-attention moment in the app, yet appear with no motion.
   ```tsx
   // src/components/whirl/interaction-card.tsx:~43 and ~72 — current roots
   <div className="mb-3 overflow-hidden rounded-xl bg-well shadow-[inset_0_0_0_1px_var(--well-outline)]" role="group" aria-label="Permission required">
   ```
5. **Banners** (reconnecting, waiting for approval, memory blocked).
   ```tsx
   // src/components/whirl/chat-view.tsx:~520 — Banner root
   <div className={cn('z-10 flex items-center justify-between gap-3 px-4 py-2 text-[12px] sm:px-6', ...)} role="status">
   ```

This is deliberately **not** a general "animate everything that mounts" pass —
route switching, the sidebar list and the transcript are excluded (see the
README's rejected candidates).

## Target

One shared entrance class using `@starting-style` (no JS, no keyframes), and a
small exit state for the run card. 200 ms, strong `ease-out`, movement + opacity
only. Reduced motion keeps the opacity and drops the travel.

```css
/* src/styles/whirl/workbench.css — append (unlayered, same as .wb-scroll) */

/* A surface that mounts into view while the user is watching it. Gesture-
   free entrance via @starting-style: the element fades and lifts 6px once,
   on insertion. No keyframes — these surfaces can be re-triggered rapidly
   (queued items, attachments) and must retarget, not restart. */
.wb-enter {
  opacity: 1;
  transform: translateY(0);
  transition:
    opacity 200ms cubic-bezier(0.23, 1, 0.32, 1),
    transform 200ms cubic-bezier(0.23, 1, 0.32, 1);
}

@starting-style {
  .wb-enter {
    opacity: 0;
    transform: translateY(6px);
  }
}

/* Exit for surfaces React removes on a timer (the run summary). */
.wb-enter[data-leaving] {
  opacity: 0;
  transform: translateY(6px);
  transition:
    opacity 150ms cubic-bezier(0.23, 1, 0.32, 1),
    transform 150ms cubic-bezier(0.23, 1, 0.32, 1);
}

@media (prefers-reduced-motion: reduce) {
  .wb-enter {
    transition: opacity 200ms ease;
    transform: none;
  }
  @starting-style {
    .wb-enter { transform: none; }
  }
  .wb-enter[data-leaving] {
    transition: opacity 150ms ease;
    transform: none;
  }
}
```

### Apply the class

Add `wb-enter` to the five roots above (attachments tray, queued card,
run-summary root, both interaction-card roots, Banner root). Do not change
their markup or classes otherwise.

### Run summary exit

`RunSummary` currently disappears the instant `expired` flips. Add a short
leaving phase so it fades out instead of blinking:

```tsx
// src/components/whirl/run-summary.tsx — extra state
const [leaving, setLeaving] = useState(false);

// replace the two setExpired(true) calls with a beginExit()
const beginExit = () => {
  setLeaving(true);
  window.setTimeout(() => setExpired(true), 160);
};

/* A finished Run reports its outcome once, then the summary yields the
   composer back to the conversation. */
useEffect(() => {
  if (active) { setExpired(false); setLeaving(false); return; }
  const ended = run.ended || Date.now();
  const remaining = 20_000 - (Date.now() - ended);
  if (remaining <= 0) { beginExit(); return; }
  const timer = window.setTimeout(beginExit, remaining);
  return () => window.clearTimeout(timer);
}, [active, run.ended, run.id]);
```

```tsx
// root div — add data-leaving
data-leaving={leaving ? '' : undefined}
className={cn('wb-enter mb-2 flex flex-wrap items-center ...', ...)}
```

Keep the early `if (expired) return null;`. The Rules-of-Hooks comment above
that return must stay before it (compute `action` first), unchanged.

## Repo conventions to follow

- `@starting-style` is new to this codebase; the closest existing pattern is
  the "one-shot ease-in for content that lands after a loading state" comment
  in `globals.css`. Add a comment in that voice.
- Transient behaviour classes are unlayered in `workbench.css` (`.wb-scroll`,
  `.wb-markdown`). Do not use a Tailwind `@utility` here.
- The class must not animate `opacity` on elements that are already inside a
  `backdrop-blur` ancestor in a way that pins a render surface — the dock
  composer already carries `backdrop-blur-xl`; a 6px translate on a sibling
  card is fine, but do not add `filter` to `.wb-enter`.

## Steps

1. Append the `.wb-enter` CSS block to `src/styles/whirl/workbench.css`.
2. `composer.tsx`: add `wb-enter` to the attachments tray `div` (line ~166).
3. `chat-view.tsx`: add `wb-enter` to the queued card `div` (line ~410); add
   it to the `Banner` root (line ~520).
4. `interaction-card.tsx`: add `wb-enter` to both root `div`s (permission and
   question).
5. `run-summary.tsx`: add `leaving` state, `beginExit`, the updated effect,
   and `data-leaving` + `wb-enter` on the root.
6. Run `npm run check`.

## Boundaries

- Do NOT animate the transcript, sidebar, tabs, route content or the composer
  itself.
- Do NOT add an exit animation to attachments, queued items or banners —
  React removes them synchronously and a leaving state there is a larger
  change than the payoff. Entrance only for those.
- Do NOT change any `role`, `aria-live` or `key`.
- Do NOT add `will-change` or `filter`.
- The run card's 20 s expiry is not in scope; only the removal transition is.

## Verification

- **Mechanical**: `npm run check` passes. `grep -rn "wb-enter" src/` shows the
  CSS plus the five roots and the run-summary root.
- **Feel check**: start `npm run dev`.
  - Attach a file in the composer: the tile fades up 6px into place.
  - Start a task, then send a second message while it runs: the queued card
    lifts in; the run summary is already there.
  - Let a run finish and wait ~20 s: the summary fades and lifts before it
    unmounts — no blink.
  - Trigger a permission card (or clear it): it enters smoothly.
  - Force `connectionError` (stop the gateway) to see the banner enter.
  - Rendering panel → reduced motion: each surface still fades in, with no
    vertical travel.
- **Done when**: the five surfaces enter with motion, the run card exits with
  motion, and reduced motion keeps opacity only.
