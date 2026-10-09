# 009 — Reduced motion, transparency and contrast

- **Status**: TODO
- **Commit**: f509488
- **Severity**: MEDIUM
- **Category**: Accessibility
- **Estimated scope**: 3 files (`globals.css`, `loading-ui/dots-ring.tsx`, `home-view.tsx`), ~45 lines

## Problem

The app handles `prefers-reduced-motion` for its own keyframes (`.text-shimmer`,
`.artifact-progress-bar`, `.t-skel-*`, `.t-page-slide`), but **not** for the
motion that actually runs in the current UI:

1. **tw-animate-css has no reduced-motion handling at all.** Every dialog,
   popover, tooltip and menu animates a scale/slide/filter under
   `prefers-reduced-motion: reduce`. Verified:
   `grep "prefers-reduced-motion" node_modules/tw-animate-css/dist/tw-animate.css`
   → no matches. The library only sets CSS variables via utilities
   (`zoom-in-95` → `--tw-enter-scale: calc(95 * 1%)`, `slide-in-from-top-2` →
   `--tw-enter-translate-y`, `spin-in`, `blur-in`).
2. **`animate-pulse` on the live-agent dot** (`home-view.tsx:123`) runs
   regardless of the setting.
3. **`DotsRing`** (the "agent working" indicator, used in the sidebar, tabs,
   run summary) injects a `pulse + scale` keyframe loop with no reduced-motion
   branch.

Emil: reduced motion means **fewer and gentler** animations, not zero — keep
opacity/colour that aid comprehension, remove movement, position and scale.
The Apple-design skill adds two more independent signals the app ignores:
`prefers-reduced-transparency` (frostier/solid materials) and
`prefers-contrast: more` (defined borders).

## Target

### 1. Neutralise tw-animate transforms, keep the fade

Append to `src/styles/whirl/globals.css`, unlayered (like the other behaviour
rules there), after the imports:

```css
/* tw-animate-css ships no reduced-motion handling, so dialogs, popovers,
   tooltips and menus would still scale/slide/spin. Reset the transform and
   filter channels (never opacity) so the fade — which aids comprehension —
   survives and only the movement goes. !important because the utility that
   set the variable (`data-open:zoom-in-95`, `slide-in-from-top-2`, …) is a
   variant selector with equal specificity. */
@media (prefers-reduced-motion: reduce) {
  [class*="animate-in"],
  [class*="animate-out"] {
    --tw-enter-translate-x: 0 !important;
    --tw-enter-translate-y: 0 !important;
    --tw-enter-scale: 1 !important;
    --tw-enter-rotate: 0 !important;
    --tw-enter-blur: 0 !important;
    --tw-exit-translate-x: 0 !important;
    --tw-exit-translate-y: 0 !important;
    --tw-exit-scale: 1 !important;
    --tw-exit-rotate: 0 !important;
    --tw-exit-blur: 0 !important;
  }

  /* A decorative status pulse; the dot still reads as "live" when static. */
  .animate-pulse {
    animation: none;
  }
}
```

### 2. DotsRing

Give the animated dot a class and a gentle fallback.

```tsx
// src/components/loading-ui/dots-ring.tsx — the inner animated span
<span
  className="loading-ui-dots-ring-dot block size-full rounded-full bg-current"
  style={{ animation: 'loading-ui-dots-ring-pulse var(--duration, 1s) linear infinite', animationDelay: `calc(var(--duration, 1s) / ${dotCount} * ${index - dotCount})` }}
/>
```

```css
/* add to the injected @keyframes <style> block in the same file */
@media (prefers-reduced-motion: reduce) {
  .loading-ui-dots-ring-dot {
    animation: none !important;
    opacity: 0.6;
  }
}
```

A static ring of dots still communicates "working"; the opacity gradient that
mark the head of the loop is lost, which is why a uniform `0.6` is used rather
than `1` (it reads as a quieter loader, not a finished state).

### 3. Reduced transparency

```css
/* src/styles/whirl/globals.css — append */
@media (prefers-reduced-transparency: reduce) {
  :root {
    /* Frosted surfaces go solid: legibility over a moving transcript must not
       depend on a blur the user cannot see. */
    --popover-translucent: var(--popover);
    --well-translucent: var(--well);
  }
  [class*="backdrop-blur"] {
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
  }
}
```

### 4. Reduced contrast

```css
@media (prefers-contrast: more) {
  :root { --border: rgb(0 0 0 / 0.18); }
  .dark { --border: rgb(255 255 255 / 0.18); }
}
```

## Repo conventions to follow

- Reduced-motion rules live beside the animation they guard, with a one-line
  "why". `.text-shimmer` and `.artifact-progress-bar` in `globals.css` are the
  exemplars.
- The two translucent hand-mixed tokens (`--popover-translucent`,
  `--well-translucent`) exist because the Tailwind compiler mangles
  `color-mix` over `var()`; re-pointing them to the already-defined
  `--popover` / `--well` is the intended override path.
- `prefers-reduced-transparency` and `prefers-contrast` are not yet used
  anywhere; keep them isolated in their own blocks so they are easy to find.

## Steps

1. Append blocks **1**, **3** and **4** to `src/styles/whirl/globals.css`.
2. `loading-ui/dots-ring.tsx`: add the `loading-ui-dots-ring-dot` class to the
   animated dot span and the reduced-motion rule to its injected `<style>`.
3. Confirm `home-view.tsx:123` still has `animate-pulse` — the global rule
   covers it; no tsx change needed there.
4. Run `npm run check`.

## Boundaries

- Do NOT disable `animate-spin` (spinners aid perceived performance; Emil
  keeps them).
- Do NOT set reduced motion to "no animation at all" — the see-through fades
  must remain.
- Do NOT touch `[data-sd-animate]`, `.artifact-progress-bar`, `.t-skel-*` or
  `.t-page-slide`; they already have their own reduced-motion rules.
- Do NOT change any colour token outside the `prefers-contrast` block.
- Do NOT add `prefers-reduced-motion` to `.wb-enter` here — plan 007 owns it.

## Verification

- **Mechanical**: `npm run check` passes.
  `grep -n "prefers-reduced-transparency\|prefers-contrast" src/styles/whirl/globals.css`
  shows both new blocks.
- **Feel check**: DevTools → Rendering panel.
  - Emulate **prefers-reduced-motion: reduce**. Open a dialog, a popover, the
    model picker and a context menu: each should fade in place with no
    scale/slide. The live-agent dot on Home is static. The DotsRing loader is
    a still ring.
  - Emulate **prefers-reduced-transparency: reduce**. The thread composer,
    floating pills and menus become solid; no blur remains.
  - Emulate **prefers-contrast: more**. Borders darken and read clearly.
  - Restore defaults: everything animates as before (no regression).
- **Done when**: the three settings are honoured, animation normally is
  unchanged, and `npm run check` passes.
