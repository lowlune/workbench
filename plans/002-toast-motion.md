# 002 — Toast enter/exit motion

- **Status**: TODO
- **Commit**: f509488
- **Severity**: HIGH
- **Category**: Missed opportunity / spatial consistency
- **Estimated scope**: 2 files (`src/App.tsx`, `src/styles/whirl/workbench.css`), ~40 lines

## Problem

Toasts are the app's only transient feedback surface and they have **no
motion at all**. A toast pops into existence at the bottom-right and, 4.2 s
later, blinks out. This is exactly the "content that appears or vanishes with
no bridge" case Emil lists as a valid purpose for motion, and the app gives it
none.

Current code:

```tsx
// src/App.tsx:262 — current
const showToast = useCallback((text: string, error = false) => {
  const id = Date.now() + Math.random();
  setToasts((current) => [...current.slice(-2), { id, text, error }]);
  window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4200);
}, []);
```

```tsx
// src/App.tsx:1254 — current
<div className="pointer-events-none fixed right-4 bottom-4 z-[100] flex w-[min(20rem,calc(100vw-2rem))] flex-col items-end gap-2" aria-live="polite" aria-relevant="additions text">
  {toasts.map((toast) => (
    <div
      key={toast.id}
      role={toast.error ? 'alert' : 'status'}
      className={cn(
        'raised pointer-events-auto w-full truncate rounded-xl bg-popover py-2 pr-3 pl-3 text-sm ring-1 ring-border',
        toast.error ? 'text-destructive' : 'text-popover-foreground',
      )}
    >
      {toast.text}
    </div>
  ))}
</div>
```

There is also no way to dismiss one early. Toasts can fire in rapid
succession (save, archive, delete), so the motion **must be a CSS transition,
not `@keyframes`** — transitions retarget from the current value; keyframes
restart from zero.

## Target

Enter from the bottom edge (spatial consistency — the dock is the bottom-right
corner), exit downward the same way. Transitions, `@starting-style` for the
entrance, a data attribute for the exit.

```css
/* src/styles/whirl/workbench.css — add at the end, outside @layer so it
   beats Tailwind utilities regardless of source order (same reason mobile.css
   sits unlayered). */

/* Toasts. Enter from the bottom edge and leave the same way — a toast that
   slides in from below must not fade out sideways. Transitions, never
   keyframes: toasts stack rapidly and a retarget must not restart. The exit
   drifts a short distance downward rather than a full translateY(100%),
   because a middle toast of the column would otherwise slide across its
   siblings — the stack itself is not FLIP-animated (follow-up). */
.wb-toast {
  opacity: 1;
  transform: translateY(0);
  transition:
    opacity 400ms ease,
    transform 400ms ease;
}

@starting-style {
  .wb-toast {
    opacity: 0;
    transform: translateY(100%);
  }
}

.wb-toast[data-leaving] {
  opacity: 0;
  transform: translateY(8px);
  transition:
    opacity 250ms cubic-bezier(0.23, 1, 0.32, 1),
    transform 250ms cubic-bezier(0.23, 1, 0.32, 1);
}

@media (prefers-reduced-motion: reduce) {
  .wb-toast {
    transition: opacity 200ms ease;
    transform: none;
  }
  @starting-style {
    .wb-toast { transform: none; }
  }
  .wb-toast[data-leaving] {
    transition: opacity 200ms ease;
    transform: none;
  }
}
```

`400ms ease` (not `ease-out`) is deliberate: Sonner reads as elegant because
its motion matches the component's personality — slightly slower, `ease`
rather than `ease-out`. The exit is faster (250 ms, strong ease-out): the
system responding should snap, the arrival can take its time.

React changes (state + JSX only, no structure change):

```tsx
// src/App.tsx — extend the type
interface ToastMessage {
  id: number;
  text: string;
  error: boolean;
  leaving?: boolean;
}
```

```tsx
// src/App.tsx — replace showToast and add dismissToast
const dismissToast = useCallback((id: number) => {
  setToasts((current) => current.map((toast) => toast.id === id ? { ...toast, leaving: true } : toast));
  window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 260);
}, []);

const showToast = useCallback((text: string, error = false) => {
  const id = Date.now() + Math.random();
  setToasts((current) => [...current.slice(-2), { id, text, error }]);
  window.setTimeout(() => dismissToast(id), 4200);
}, [dismissToast]);
```

```tsx
// src/App.tsx:1254 — add the class and the leaving attribute
{toasts.map((toast) => (
  <div
    key={toast.id}
    role={toast.error ? 'alert' : 'status'}
    data-leaving={toast.leaving ? '' : undefined}
    className={cn(
      'wb-toast raised pointer-events-auto w-full rounded-xl bg-popover py-2 pr-3 pl-3 text-sm ring-1 ring-border',
      toast.error ? 'text-destructive' : 'text-popover-foreground',
    )}
  >
    {toast.text}
  </div>
))}
```

Note: `truncate` is intentionally dropped to `line-clamp-2`-friendly copy in
plan 012; keep `truncate` here to hold the diff minimal, and do not change the
copy. If you prefer, keep `truncate` — it is not part of this plan.

## Repo conventions to follow

- Transient/one-off behaviour classes live in `workbench.css` unlayered, the
  same place `.wb-scroll`, `.wb-markdown` and `.tool-row` live. Do not add a
  Tailwind `@utility` for a one-use animation.
- The repo already uses `@starting-style`-equivalent patterns? No — this is
  the first. Follow the reduced-motion comment style of `.artifact-progress-bar`
  in globals.css: a short comment stating why, then the reduced rule.
- `dismissToast` must remain a `useCallback` with a stable identity so the
  `showToast` dependency does not re-create every render.

## Steps

1. In `src/App.tsx`, add `leaving?: boolean` to `ToastMessage` (~line 49).
2. Replace the `showToast` callback (lines 262–266) with the `dismissToast` +
   `showToast` pair from **Target**. Keep the `slice(-2)` cap and the 4200 ms
   budget.
3. In the toast render (line ~1254), add `data-leaving` and the `wb-toast`
   class exactly as shown. Keep `role`, `aria-live`, `pointer-events` and
   `key` unchanged.
4. Append the `.wb-toast` CSS block to `src/styles/whirl/workbench.css`.
5. Run `npm run check`.

## Boundaries

- Do NOT switch the toast container to a library (no Sonner install).
- Do NOT touch the `aria-live` container's positioning, width or stacking
  order.
- Do NOT add a dismiss button or swipe; that is a separate feature, not motion.
- Do NOT change any `showToast` call site's text or error flag.
- If `ToastMessage` already has fields beyond `id/text/error` by the time you
  read it, STOP and report.

## Verification

- **Mechanical**: `npm run check` passes. `grep -n "wb-toast" src/App.tsx
  src/styles/whirl/workbench.css` shows both the class and the rule.
- **Feel check**: start `npm run dev`. Trigger a toast (e.g. archive a
  conversation, or set concurrency to save). Confirm:
  - The toast rises from the bottom edge into place over ~400 ms; it does not
    pop.
  - On expiry it fades and drifts down, then unmounts — no blink.
  - Fire three toasts quickly (archive, then delete another): later toasts do
    not restart the earlier one's animation, and the stack never jitters.
  - In DevTools → Animations, set playback to 10% and confirm the enter and
    exit are smooth with no 0%→100% restart.
  - Rendering panel → emulate `prefers-reduced-motion: reduce`: toasts still
    fade (understandable feedback) but do not travel.
- **Done when**: toasts animate in and out, rapid firing retargets cleanly,
  and reduced motion keeps the fade without the slide.
