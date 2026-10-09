# 012 — Miscellaneous polish

- **Status**: TODO
- **Commit**: f509488
- **Severity**: LOW
- **Category**: Polish
- **Estimated scope**: 4 files (`dots-ring.tsx`, `workbench.css`, `App.tsx`), ~35 lines

## Problem

Three small issues found during the audit; each is independent.

**(a) `DotsRing` injects a `<style>` tag per instance.** The keyframes are
declared inside the component, so every mounted ring (sidebar run rows, tab
strip, run summary, live-agent card) renders its own copy of the `<style>`
block. With several running agents this is duplicated CSS text in the DOM and
repeated style recalculation on mount.

```tsx
// src/components/loading-ui/dots-ring.tsx:23-33 — current
<>
  <style>{`
    @keyframes loading-ui-dots-ring-pulse { … }
  `}</style>
  <span …>
```

**(b) Toast text is single-line truncated.** Long error messages are cut off
with no way to read them, which `break-ui` flags directly ("Truncated text
with no way to read it"). Toasts are the only place errors surface.

```tsx
// src/App.tsx:~1262 — current
className={cn(
  'raised pointer-events-auto w-full truncate rounded-xl bg-popover py-2 pr-3 pl-3 text-sm ring-1 ring-border',
  …
)}
```

**(c) The toast stack ignores the bottom safe area.** It is pinned at
`bottom-4`, so on a notched phone the newest toast can sit under the home
indicator.

```tsx
// src/App.tsx:1254 — current
<div className="pointer-events-none fixed right-4 bottom-4 z-[100] …" …>
```

## Target

### (a) Hoist the DotsRing keyframes

Move the `@keyframes` to `workbench.css` and delete the inline `<style>`. Do
this **after** plan 009, which adds a `.loading-ui-dots-ring-dot` reduced-motion
rule inside the same inline block — move both together.

```css
/* src/styles/whirl/workbench.css — append */
@keyframes loading-ui-dots-ring-pulse {
  0%, 100% { opacity: 0.25; transform: scale(0.65); }
  12.5%     { opacity: 1;    transform: scale(1); }
  25%       { opacity: 0.75; transform: scale(0.85); }
  50%       { opacity: 0.35; transform: scale(0.7); }
}

@media (prefers-reduced-motion: reduce) {
  .loading-ui-dots-ring-dot {
    animation: none !important;
    opacity: 0.6;
  }
}
```

```tsx
// src/components/loading-ui/dots-ring.tsx — remove the <style> element entirely
// (and the surrounding fragment if it becomes a single child)
return (
  <span
    role="status"
    className={cn('@container-[size] relative inline-flex aspect-square items-center justify-center', className)}
    style={style}
    {...props}
  >
    …unchanged…
  </span>
);
```

Keep the `loading-ui-dots-ring-dot` class on the animated dot from plan 009.

### (b) Let a toast wrap to two lines

```tsx
// src/App.tsx:~1262
className={cn(
  'wb-toast raised pointer-events-auto w-full rounded-xl bg-popover py-2 pr-3 pl-3 text-sm ring-1 ring-border',
  'line-clamp-2 break-words',
  toast.error ? 'text-destructive' : 'text-popover-foreground',
)}
```

`line-clamp-2` bounds the height (the stack stays predictable) while a normal
error message fits; `break-words` stops a long path or URL overflowing the
card. Remove `truncate` (single-line).

### (c) Toast safe area

```tsx
// src/App.tsx:1254
className="pointer-events-none fixed right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-[100] flex w-[min(20rem,calc(100vw-2rem))] flex-col items-end gap-2"
```

## Repo conventions to follow

- Behaviour/keyframe classes live unlayered in `workbench.css` (`.wb-scroll`,
  `.wb-markdown`). The keyframes belong there, not in a component.
- The safe-area pattern is already used elsewhere:
  `pb-[max(4px,env(safe-area-inset-bottom))]` on the mobile tab bar and
  `pt-[max(0.75rem,env(safe-area-inset-top))]` on the chat chrome. Match it.
- `line-clamp-*` is used in `chat-view.tsx` (queued messages) and
  `notifications-center.tsx`, so it is the established truncation idiom.

## Steps

1. `dots-ring.tsx`: delete the inline `<style>` block; return the single
   `<span>` (drop the fragment if it is now unnecessary).
2. `workbench.css`: append the hoisted `@keyframes` and the reduced-motion
   rule (if plan 009 has not landed, add the rule now and skip step 0).
3. `App.tsx`: replace `truncate` with `line-clamp-2 break-words` on the toast
   card.
4. `App.tsx`: add the safe-area bottom offset to the toast container.
5. Run `npm run check`.

## Boundaries

- Do NOT change the DotsRing geometry, dot count, scale or radius math.
- Do NOT restructure the toast container, its `aria-live`, or the enter/exit
  motion from plan 002.
- Do NOT remove `wb-toast` (plan 002) when editing the toast class list.
- Do NOT add safe-area padding anywhere else in this plan.

## Verification

- **Mechanical**: `npm run check` passes. `grep -rn "<style>" src/components/loading-ui/dots-ring.tsx`
  returns nothing. `grep -n "line-clamp-2" src/App.tsx` shows the toast.
- **Feel check**: start `npm run dev`.
  - Trigger several concurrent runs; open DevTools → Elements and confirm
    there is only one `@keyframes loading-ui-dots-ring-pulse` source (in the
    stylesheet), not one per ring.
  - Trigger a long error toast (e.g. stop the gateway and try an action): the
    message wraps to two lines and is readable, and the card does not grow
    without bound on a very long message.
  - On a phone (or emulation with safe-area insets), the toast clears the home
    indicator.
  - Rendering panel → reduced motion: the DotsRing is a still ring.
- **Done when**: no per-instance `<style>`, toasts wrap to two lines and clear
  the safe area, and `npm run check` passes.
