# 011 — Audit and prune the dead Whirl CSS

- **Status**: TODO
- **Commit**: f509488
- **Severity**: LOW
- **Category**: Cleanup / cohesion
- **Estimated scope**: 3 files (`globals.css`, `accents.css`, `tint.css`), net deletion

## Problem

`src/styles/whirl/globals.css` is the full Whirl design-system stylesheet,
ported wholesale. Workbench implements only a subset of that system, so a
large fraction of the file describes components that do not exist here. This
is not merely tidy-up:

- It inflates the CSS bundle (these are not dead-code-eliminated — they are
  plain rules in the imported file).
- It creates name collisions risk (`.sidebar-glide`, `.text-shimmer`) and
  duplicate motion vocabulary (`.sidebar-glide` re-declares the drawer bezier
  that plan 001 makes a token).
- It misleads readers: the file "documents" tokens (`--series-*`,
  `--platinum-metal-*`), imports (`accents.css`, `tint.css`) and components
  (`Platinum*`, TiPTap editor, Streamdown, SkeletonReveal, PageSlide,
  open-source orbits) that no one can find.

Verified absence (grep returns no `.ts`/`.tsx` consumer):

```
.sidebar-glide     0    .platinum-page    0    .platinum-ground  0
.platinum-rule     0    .text-shimmer     0    [data-sd-animate] 0
.artifact-progress 0    .body-fade-in     0    .image-shimmer    0
.oss-orbit         0    .tiptap-prose     0    .edit-flash       0
.t-skel            0    .t-page-slide     0    --series-*        0
--chart-*          0    data-accent       0    data-tinted       0
```

## Target

Delete only what is provably unused, keep the shared primitives, and record
the decision. **Do not delete a block you have not grepped for a consumer.**

### Remove (confirmed dead)

From `globals.css`:

| Block | Reason |
| --- | --- |
| `.sidebar-glide` rule (lines ~30–38) | no consumer; duplicate of `--ease-drawer` |
| `.platinum-page`, `.platinum-ground`, `.platinum-rule` (the whole Platinum block) | no Platinum components |
| `.text-shimmer`, `@keyframes text-shimmer`, `[torph-root]`/`[torph-item]` rules | no torph/streamdown |
| `[data-sd-animate]` + its reduced-motion rule | streamdown not used |
| `@keyframes artifact-progress`, `.artifact-progress-bar`, `artifact-progress-pulse` media block | no artifact card |
| `@keyframes body-fade-in`, `.body-fade-in` | no consumer |
| `@keyframes image-shimmer`, `.image-shimmer-gleam` | no consumer |
| `@keyframes oss-orbit`, `.oss-orbit` | no open-source hero |
| the entire `/* ---- TipTap document editor ---- */` section (`.tiptap-prose`, tables, KaTeX, `.edit-flash`, `@keyframes editFlash`) | no editor |
| the Transitions.dev `--pulse-*`/`--reveal-*` vars, `.t-skel*`, `@keyframes t-skel-pulse` | no `SkeletonReveal` |
| the Transitions.dev `--page-*` vars, `.t-page-slide`, `.t-page` rules | no `PageSlide` |
| `--series-1..8` and `--platinum-metal-*` tokens | no chart/palette/wordmark |

From `accents.css`: the whole file (no code sets `data-accent`).

From `tint.css`: the whole file (no code sets `data-tinted`).

Then remove the two imports in `globals.css`:

```css
/* remove these two lines near the top */
@import "./accents.css";
@import "./tint.css";
```

### Keep (verify each before touching)

- The colour/radius token blocks (`:root`, `.dark`, `@theme inline`) —
  `--surface`, `--background`, `--well*`, `--foreground-soft`,
  `--popover-translucent`, `--destructive-soft`, etc. are all live.
- `--chart-1..5` — leave until you have grepped; the shadcn theme maps them.
  Delete only if `grep -rn "chart-1\|chart-2" src/` is empty.
- `.dark .raised` — `raised` is used widely.
- `.app-loading`, `.field-text` (mobile.css), `.wb-*`, `.hljs-*`.
- `@layer base` rules and the `html, body` font literal (the comment there
  explains why it must stay spelled out).
- The `.text-shimmer`-adjacent reduced-motion block is removed with its rule.

## Repo conventions to follow

- The file's own comments justify each block; when you delete a block, delete
  its comment with it.
- If a block is kept but genuinely belongs to a different system, move it to
  `workbench.css` and label it. Do not leave speculative rules in `globals.css`.
- This plan runs **after** 001/009/010 because those touch neighbouring rules;
  re-verify line numbers at execution time.

## Steps

1. For each row in the **Remove** table, run the matching grep and confirm
   zero consumers in `src/`:
   `grep -rn "<selector>" src --include=*.ts --include=*.tsx`.
   If any grep is non-empty, keep that block and note it in your report.
2. Delete the confirmed-dead blocks from `globals.css`.
3. Delete `src/styles/whirl/accents.css` and `src/styles/whirl/tint.css`, and
   remove their two `@import` lines.
4. Re-run the greps from step 1; all must be empty.
5. Run `npm run check` and `npx vite build`; compare the emitted CSS size
   before and after and report the delta.
6. Visual smoke: `npm run dev`, load Home, a chat, History, Clips, Usage,
   System, Notifications in both light and dark. Nothing may change.

## Boundaries

- Do NOT delete tokens or rules you have not grepped for a consumer.
- Do NOT touch the `prefers-reduced-motion` rules that belong to live
  components (tw-animate neutralisation from 009, `.wb-enter` from 007,
  scrollbars, `.wb-markdown`).
- Do NOT remove the `@import "tailwindcss"`, `"gradient-border-plugin"`,
  `"tw-animate-css"` or `"shadcn/tailwind.css"` imports.
- Do NOT merge this with any motion change; it must be a deletion-only diff
  so a visual regression is trivially attributable.
- If a component turns out to use a block you were told to delete, keep the
  block and report the contradiction rather than editing the component.

## Verification

- **Mechanical**: `npm run check` passes; `npx vite build` succeeds; every
  grep from step 1 is empty; the built CSS file is smaller.
- **Visual smoke**: as in step 6 — light and dark, every route, plus a modal,
  the model picker and a context menu. Pixel-identical to before (screenshot
  diff if tooling is available).
- **Done when**: the dead blocks and the two imports are gone, the bundle is
  smaller, and the app is visually unchanged.
