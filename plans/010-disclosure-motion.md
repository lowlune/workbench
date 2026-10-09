# 010 — Animate `<details>` disclosure (tool calls)

- **Status**: TODO
- **Commit**: f509488
- **Severity**: LOW
- **Category**: Missed opportunity / preventing a jarring change
- **Estimated scope**: 3 files (`workbench.css`, `thread/activity.tsx`, `thread/tool-cards.tsx`), ~30 lines

## Problem

Every tool-call disclosure is a native `<details>`/`<summary>`. The chevron
rotates (already animated), but the **content snaps open and shut instantly** —
the panel teleports from 0 to its full height in one frame. That is the
"content that appears or vanishes with no bridge" case.

```tsx
// src/components/whirl/thread/activity.tsx:28 — current
<details className="group/activity w-full min-w-0">
  <summary className="tool-row flex w-fit max-w-full cursor-pointer list-none items-center gap-1.5 text-[12.5px] text-muted-foreground marker:hidden [&::-webkit-details-marker]:hidden">
    ...
    <IconChevronRight size={12} className="shrink-0 text-muted-foreground/60 transition-transform duration-150 group-open/activity:rotate-90" />
  </summary>
  <div className="mt-1.5 space-y-1.5">
    {tools.map((part) => <ToolRenderer key={part.id} view={classifyPart(part)} onOpenFile={onOpenFile} />)}
  </div>
</details>
```

The same pattern is in `tool-cards.tsx` (the command, test, git and generic
`<details className="group/cmd|test|git|tool …">` blocks).

Rail tick / tool disclosures are opened by the user occasionally, so a
short 200 ms height+opacity transition is appropriate. This is one of the few
places `height` is tolerated (Emil: "height is tolerated only for accordions,
where there's no transform equivalent").

## Target

Use the modern `::details-content` pseudo-element with `interpolate-size` and
`content-visibility: allow-discrete`. It degrades gracefully: where the
selectors are unsupported, the disclosure behaves exactly as it does today
(instant), so there is no regression.

```css
/* src/styles/whirl/workbench.css — append (unlayered) */

/* Native <details> disclosures (tool calls). `interpolate-size: allow-keywords`
   lets block-size animate to/from `auto`; ::details-content is the browser's
   own wrapper for the toggled content, so no extra DOM is needed. Where
   ::details-content is unsupported the declaration is inert and the
   disclosure snaps as before — progressive enhancement, not a regression.
   Height is the one sanctioned non-GPU animation: there is no transform
   equivalent for a disclosure. */
.wb-disclosure {
  interpolate-size: allow-keywords;
}

.wb-disclosure::details-content {
  block-size: 0;
  overflow: clip;
  opacity: 0;
  transition:
    block-size 200ms cubic-bezier(0.23, 1, 0.32, 1),
    opacity 200ms cubic-bezier(0.23, 1, 0.32, 1),
    content-visibility 200ms allow-discrete;
}

.wb-disclosure[open]::details-content {
  block-size: auto;
  opacity: 1;
}

@media (prefers-reduced-motion: reduce) {
  .wb-disclosure::details-content {
    transition: opacity 150ms ease;
  }
}
```

Apply `wb-disclosure` to each `<details>`:

```tsx
// src/components/whirl/thread/activity.tsx:28
<details className="wb-disclosure group/activity w-full min-w-0">

// src/components/whirl/thread/tool-cards.tsx — each of the four <details>
<details className="wb-disclosure group/cmd …">
<details className="wb-disclosure group/test …">
<details className="wb-disclosure group/git …">
<details className="wb-disclosure group/tool …">
```

Do not touch the `<summary>` or the inner content `div`.

## Repo conventions to follow

- One-off behaviour classes live unlayered in `workbench.css` (`.wb-scroll`,
  `.tool-row`). Put this there, not in a Tailwind `@utility`.
- The 200 ms + strong `ease-out` matches the disclosure budget and plan 001.
- Keep the existing `transition-transform` on the chevron; do not fold it into
  the disclosure transition.

## Steps

1. Append the `.wb-disclosure` CSS block to `src/styles/whirl/workbench.css`.
2. `thread/activity.tsx`: add `wb-disclosure` to the single `<details>`.
3. `thread/tool-cards.tsx`: add `wb-disclosure` to every `<details>` in the
   file (grep `details className=` to find them all).
4. Run `npm run check`.

## Boundaries

- Do NOT convert `<details>` to a React-controlled accordion.
- Do NOT animate `height` on any other element.
- Do NOT change the summary layout, marker hiding, chevron or content markup.
- Do NOT apply `wb-disclosure` to any non-`<details>` element.

## Verification

- **Mechanical**: `npm run check` passes. `grep -rn "wb-disclosure" src/` shows
  the CSS plus every `<details>`.
- **Feel check**: start `npm run dev`, open a conversation with a multi-tool
  assistant turn.
  - Click "tool calls N": the panel opens over ~200 ms, fading and growing;
    the chevron still rotates.
  - Click again: it collapses over ~200 ms.
  - Open several in rapid succession: none double-animates or sticks.
  - DevTools → Animations at 10%: block-size and opacity move together, no
    snap.
  - Rendering panel → reduced motion: the panel still fades, without the
    height growth.
  - In Firefox/Safari (if available): if `::details-content` is unsupported,
    confirm the disclosure still toggles instantly (graceful fallback).
- **Done when**: tool disclosures grow/collapse smoothly in Chromium, fall
  back cleanly elsewhere, and reduced motion keeps the fade.
