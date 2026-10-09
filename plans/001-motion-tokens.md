# 001 — Shared motion tokens

- **Status**: TODO
- **Commit**: f509488
- **Severity**: MEDIUM
- **Category**: Cohesion & tokens
- **Estimated scope**: 1 file (`src/styles/whirl/globals.css`), ~20 lines

## Problem

The app has no shared motion vocabulary. Easing curves are hand-typed in
three different shapes, and the curves that do exist are not the strong
custom ones Emil's `animate` skill requires.

Current state:

```css
/* src/styles/whirl/globals.css:32 — .sidebar-glide (unused, see plan 011) */
.sidebar-glide {
  transition-duration: 240ms;
  transition-timing-function: cubic-bezier(0.32, 0.72, 0, 1);
}

/* src/styles/whirl/globals.css (t-page-slide block, dead markup) */
--page-slide-ease: cubic-bezier(0.22, 1, 0.36, 1);

/* src/components/whirl/conversation-nav.tsx:82 */
'... transition-all duration-200 ease-out'
```

There is no `--ease-*` token anywhere (`grep -n "ease-" globals.css` returns
only comments). Tailwind v4's built-in `--ease-out` is
`cubic-bezier(0, 0, 0.2, 1)`, which Emil explicitly calls too weak: "The
built-in CSS easings are too weak. They lack the punch that makes animations
feel intentional."

Every subsequent plan references `var(--ease-out)` / `var(--ease-in-out)` /
`var(--ease-drawer)`. Without this plan they would each hand-type a bezier,
which is the defect this plan exists to prevent.

## Target

Add the strong curves as Tailwind theme tokens in the existing
`@theme inline` block, and duration tokens in `:root`. Overriding
`--ease-out` and `--ease-in-out` here upgrades every existing `ease-out` /
`ease-in-out` utility in the app at once — that is intended.

```css
/* src/styles/whirl/globals.css — inside the existing `@theme inline { … }` */
  /* Strong custom curves. The built-in CSS easings are too weak for UI:
     they lack the punch that makes motion read as intentional. Overriding
     Tailwind's --ease-out / --ease-in-out upgrades every `ease-out` /
     `ease-in-out` utility app-wide (the point of a token). */
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);       /* entering / exiting */
  --ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);   /* on-screen movement */
  --ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);    /* iOS-like sheet curve (Ionic) */

/* src/styles/whirl/globals.css — inside the existing `:root { … }` */
  /* Motion duration budget. UI animations stay under 300ms. */
  --duration-press: 160ms;     /* button press feedback 100–160ms */
  --duration-tooltip: 150ms;   /* tooltips, small popovers 125–200ms */
  --duration-popover: 200ms;   /* dropdowns, selects 150–250ms */
  --duration-modal: 250ms;     /* modals, drawers 200–500ms */
  --duration-toast: 400ms;     /* Sonner personality: slightly slower, ease */
```

Then replace the two hand-typed beziers with the token:

```css
/* .sidebar-glide — keep the rule (plan 011 decides its fate) but use the token */
.sidebar-glide {
  transition-duration: 240ms;
  transition-timing-function: var(--ease-drawer);
}
```

## Repo conventions to follow

- New global CSS tokens live in `src/styles/whirl/globals.css`, split as
  today: `@theme inline { … }` maps tokens into Tailwind utilities; `:root`
  holds raw custom properties. See the existing `--radius` and
  `--well-outline` declarations.
- The file already documents *why* each token exists in a comment above it.
  Follow that style — the comment is the justification, keep it.
- Do **not** create a parallel token file. One vocabulary in one place.

## Steps

1. Open `src/styles/whirl/globals.css`. In the `@theme inline { … }` block
   (starts around line 130), add `--ease-out`, `--ease-in-out` and
   `--ease-drawer` exactly as in **Target**.
2. In the `:root { … }` block (starts around line 40), add the five
   `--duration-*` tokens exactly as in **Target**.
3. Replace the literal `cubic-bezier(0.32, 0.72, 0, 1)` in `.sidebar-glide`
   with `var(--ease-drawer)`.
4. Do **not** bulk-replace `duration-150` / `duration-100` utilities with
   the new tokens in this plan. Existing utilities stay until a later plan
   touches the specific component; this plan only establishes the tokens.
5. Run `npm run check` — `check-radius.mjs` and `tsc --noEmit` must pass.

## Boundaries

- Do NOT touch any `.tsx` file in this plan.
- Do NOT remove the `.sidebar-glide` or `t-page-slide` blocks — plan 011
  handles dead CSS. Only swap the literal curve in `.sidebar-glide`.
- Do NOT add a motion library or any dependency.
- Do NOT change colours, radii, spacing or any contract token; you are only
  adding motion tokens and one curve substitution.

## Verification

- **Mechanical**: `npm run check` passes. `grep -n "ease-out" src/styles/whirl/globals.css`
  shows the new token. `grep -rn "cubic-bezier(0.32, 0.72, 0, 1)" src/`
  returns only the new `--ease-drawer` definition.
- **Feel check**: start `npm run dev`, open the app. Hover the sidebar and
  a button; the hover colour transitions now ease on the strong curve
  (slightly snappier tail than before). Nothing should look *faster* or
  *broken* — this is a subtle curve change. Toggle the theme; the button
  transition is unchanged.
- **Done when**: tokens exist, the one literal is substituted, `npm run
  check` passes, and no component's timings were changed.
