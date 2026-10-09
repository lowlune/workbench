# 003 — Command palette opens instantly

- **Status**: TODO
- **Commit**: f509488
- **Severity**: HIGH
- **Category**: Purpose & frequency
- **Estimated scope**: 2 files (`src/components/ui/dialog.tsx`, `src/components/whirl/search-palette.tsx`), ~25 lines

## Problem

The search palette is opened with `⌘K` (or the sidebar "Search" row) — a
keyboard-initiated action used dozens to hundreds of times a day. It currently
plays a 150 ms zoom+fade entrance and a backdrop fade, because it shares
`DialogContent` with ordinary modals:

```tsx
// src/components/ui/dialog.tsx:49 — current backdrop
className={cn(
  'fixed inset-0 z-50 bg-black/40 duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0',
  backdropClassName,
)}

// src/components/ui/dialog.tsx:57 — current popup
className={cn(
  'raised fixed top-[22vh] left-1/2 z-50 w-[calc(100vw-2rem)] max-w-sm -translate-x-1/2 rounded-xl bg-popover p-4 text-popover-foreground ring-1 ring-border duration-150 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
  className,
)}
```

Emil's rule is unambiguous: **never animate a keyboard-initiated action.**
"Raycast has no open/close animation. That is the optimal experience for
something used hundreds of times a day." The animation makes an instant
action feel delayed and disconnected. (This palette is the `cmdk`-class case
in `find-animation-opportunities` — a rejected-candidate by definition.)

## Target

Add an opt-out prop to `DialogContent` and use it from the palette. Ordinary
modals keep their entrance; the palette becomes instant.

```tsx
// src/components/ui/dialog.tsx — extend the props
function DialogContent({
  className,
  children,
  keepMounted,
  dim = true,
  instant = false,
  backdropClassName,
  ...props
}: DialogPrimitive.Popup.Props & {
  keepMounted?: boolean;
  dim?: boolean;
  /* Keyboard-initiated surfaces (the ⌘K palette) open with no animation:
     an action repeated hundreds of times a day must feel instant. */
  instant?: boolean;
  backdropClassName?: string;
}) {
```

```tsx
// src/components/ui/dialog.tsx — backdrop, animate only when not instant
{dim && (
  <DialogPrimitive.Backdrop
    data-slot="dialog-backdrop"
    className={cn(
      'fixed inset-0 z-50 bg-black/40',
      instant
        ? 'duration-0'
        : 'duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0',
      backdropClassName,
    )}
  />
)}
<DialogPrimitive.Popup
  data-slot="dialog-content"
  className={cn(
    'raised fixed top-[22vh] left-1/2 z-50 w-[calc(100vw-2rem)] max-w-sm -translate-x-1/2 rounded-xl bg-popover p-4 text-popover-foreground ring-1 ring-border outline-none',
    instant
      ? 'duration-0'
      : 'duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
    className,
  )}
  {...props}
>
```

```tsx
// src/components/whirl/search-palette.tsx:73 — pass instant
<DialogContent instant className="top-[12vh] max-w-lg gap-0 rounded-xl p-0" backdropClassName="backdrop-blur-xs">
```

## Repo conventions to follow

- `DialogContent` already takes behaviour switches as explicit props
  (`keepMounted`, `dim`, `backdropClassName`) with a one-line comment each.
  Add `instant` in the same style.
- Conditional class strings are built by moving whole Tailwind class groups
  between `cn(...)` branches (see the `dim` pattern), not by trying to defeat
  a variant utility with a plain one. `animate-none` cannot reliably override
  `data-open:animate-in`; excluding the group is the correct move.
- Keep the class ordering so `tailwind-merge` (behind `cn`) does not drop a
  conflicting class.

## Steps

1. In `src/components/ui/dialog.tsx`, add `instant?: boolean` to the
   `DialogContent` props type and destructure it (default `false`).
2. Replace the backdrop `className` and the popup `className` with the
   conditional branches from **Target**. Keep every non-animation class
   (`raised`, positioning, `ring-1`, `outline-none`) exactly as it is.
3. In `src/components/whirl/search-palette.tsx`, add `instant` to the
   `<DialogContent>` call (line ~73). Do not change any other prop.
4. Confirm no other `<DialogContent>` call site passes `instant` — only the
   palette should.
5. Run `npm run check`.

## Boundaries

- Do NOT change the palette's markup, input, list or keyboard handling.
- Do NOT add `instant` to `SystemPanel`, `NotificationsCenter`,
  `ChangesPanel`, `AgentsMdDialog`, `RenameDialog` or the settings/delete
  dialogs — those are occasional and keep their entrance.
- Do NOT remove the entrance from the shared `DialogContent` default.
- Do NOT touch the `backdrop-blur-xs` frosted scrim on the palette; only its
  opacity animation is removed.

## Verification

- **Mechanical**: `npm run check` passes. `grep -n "instant" src/components/ui/dialog.tsx
  src/components/whirl/search-palette.tsx` shows the prop, the two branches
  and the one call site.
- **Feel check**: start `npm run dev`. Press `⌘K` repeatedly, ten times
  fast. The palette must appear on the same frame every time, with no zoom,
  no fade, no backdrop fade. Press `Escape`; it disappears instantly. Then
  open the delete-confirmation dialog (occasional) and confirm it still
  fades/zooms in as before — the default path is untouched.
  - Rendering panel → emulate reduced motion: palette still opens instantly
    (no regression), dialogs open with a fade only.
- **Done when**: the palette has zero open/close animation, every other
  dialog is unchanged, and `npm run check` passes.
