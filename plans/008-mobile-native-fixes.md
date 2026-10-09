# 008 — Reconnect the mobile-native layer (real bugs)

- **Status**: TODO
- **Commit**: f509488
- **Severity**: HIGH
- **Category**: Mobile / platform bugs
- **Estimated scope**: 5 files (`mobile.css`, `workbench.css`, `App.tsx`, `index.html`, new `src/lib/viewport-insets.ts`), ~80 lines

## Problem

`src/styles/whirl/mobile.css` is the ported Whirl mobile layer. It is
**entirely inert**: every one of its shell rules targets a selector that no
longer exists in Workbench. The consequences are real, user-visible bugs on
phones.

Current dead selectors:

```css
/* src/styles/whirl/mobile.css:22 — .app-frame does not exist */
.app-frame { height: calc(100dvh - var(--keyboard-inset, 0px)); }

/* src/styles/whirl/mobile.css:40 — same */
html:has(.app-frame), body:has(.app-frame) { overflow: hidden; overscroll-behavior: none; }

/* src/styles/whirl/mobile.css:56 — .mobile-tab-bar does not exist */
[data-keyboard] .mobile-tab-bar { display: none; }
```

`grep -rn "app-frame\|mobile-tab-bar\|keyboard-inset\|data-keyboard" src/`
returns only `mobile.css` itself — no markup sets any of them, and
`components/mobile/viewport-insets.tsx` (referenced in the comment) was not
ported. So, on a phone:

1. **The keyboard covers the composer.** iOS does not resize the layout
   viewport for the software keyboard; `100dvh` stays full height, so the
   docked composer sits behind the keys and the user types blind.
2. **Pull-to-refresh / rubber-banding fires mid-chat.** The `overflow: hidden;
   overscroll-behavior: none` lock never applies, so the document scrolls and
   the iOS page rubber-bands under the app.
3. **The mobile tab bar never hides** when the keyboard is open — it sits
   between the composer and the keys.

There are also three smaller platform gaps:

4. `index.html` has a single `theme-color` (`#f7f7f8`) and no
   `interactive-widget` hint, so Android doesn't resize for the keyboard and
   the status bar colour is wrong in dark mode.
5. No `touch-action: manipulation` on controls → the legacy ~300 ms tap delay
   on some elements. (`-webkit-tap-highlight-color` is already handled.)
6. The chat composer dock has no bottom safe-area padding, so on a notched
   iPhone the send button can sit under the home indicator.

```tsx
// src/App.tsx:957 — current root (no app-frame)
<div className="flex h-dvh min-h-0 w-full overflow-hidden bg-background text-foreground">

// src/App.tsx:~1099 — current mobile nav (no mobile-tab-bar)
className="absolute inset-x-0 bottom-0 z-20 grid grid-cols-3 border-t border-border bg-(--popover-translucent) px-2 pt-1 pb-[max(4px,env(safe-area-inset-bottom))] backdrop-blur-xl md:hidden"

// src/components/whirl/chat-view.tsx:~366 — current dock (no safe-area)
<div ref={dockRef} className="pointer-events-auto mx-auto w-full max-w-[52rem] px-3 pb-3 md:px-6">
```

## Target

Restore the contract the CSS already expects, rather than rewriting the CSS.

### 1. Measure the keyboard inset (new file)

```ts
// src/lib/viewport-insets.ts
import { useEffect } from 'react';

/* iOS draws the software keyboard over the layout viewport instead of
   resizing it, so a bottom-docked composer ends up behind the keys. Measure
   the visualViewport shrink and publish it as --keyboard-inset on <html>;
   the shell's height subtracts it (mobile.css .app-frame) and the tab bar
   hides while it is open ([data-keyboard] .mobile-tab-bar). Desktop and
   Android (interactive-widget=resizes-content) report no inset, so this is a
   no-op there. */
export function useViewportInsets() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    let frame = 0;
    const update = () => {
      frame = 0;
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      root.style.setProperty('--keyboard-inset', `${Math.round(inset)}px`);
      if (inset > 80) root.setAttribute('data-keyboard', '');
      else root.removeAttribute('data-keyboard');
    };
    const onViewport = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    vv.addEventListener('resize', onViewport);
    vv.addEventListener('scroll', onViewport);
    return () => {
      vv.removeEventListener('resize', onViewport);
      vv.removeEventListener('scroll', onViewport);
      if (frame) cancelAnimationFrame(frame);
      root.style.removeProperty('--keyboard-inset');
      root.removeAttribute('data-keyboard');
    };
  }, []);
}
```

### 2. Wire the classes and the hook

```tsx
// src/App.tsx — import and call once, near the top of the component
import { useViewportInsets } from '@/lib/viewport-insets';
...
useViewportInsets();
```

```tsx
// src/App.tsx:957 — add app-frame
<div className="app-frame flex h-dvh min-h-0 w-full overflow-hidden bg-background text-foreground">
```

```tsx
// src/App.tsx:~1099 — add mobile-tab-bar
className="mobile-tab-bar absolute inset-x-0 bottom-0 z-20 grid grid-cols-3 ..."
```

### 3. Keep `theme-color` in step with the in-app toggle

The theme is a class toggle, not the OS preference, so two `<meta
name="theme-color" media=…>` tags alone will desync. Update the active tag in
the existing theme effect.

```tsx
// src/App.tsx:709
useEffect(() => {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  try { localStorage.setItem('workbench-theme', theme); } catch { /* Theme still applies for this tab. */ }
  document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
    meta.setAttribute('content', theme === 'dark' ? '#202020' : '#f3f3f3');
  });
}, [theme]);
```

(`#202020` is `--background` dark; `#f3f3f3` is `--background` light — the
chrome the status bar sits against.)

### 4. `index.html`

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />
<meta name="color-scheme" content="light dark" />
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#f3f3f3" />
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#202020" />
```

Remove the single `<meta name="theme-color" content="#f7f7f8" />`.

### 5. Base touch behaviour

```css
/* src/styles/whirl/mobile.css — inside the existing
   `@media (hover: none) and (pointer: coarse)` touch-hygiene block */

  /* The legacy ~300ms double-tap-zoom delay. Controls never double-tap-zoom;
     this makes click fire on the first tap. */
  button, a, [role="button"], [role="tab"], [role="menuitem"], summary, label {
    touch-action: manipulation;
  }
```

```css
/* src/styles/whirl/workbench.css — stop inner scrollers chaining to the page
   (the root lock already uses `none`; children want `contain` so their own
   bounce still feels native). */
.wb-scroll {
  overscroll-behavior: contain;
}
```

### 6. Composer safe area

```tsx
// chat-view.tsx:~366
<div ref={dockRef} className="pointer-events-auto mx-auto w-full max-w-[52rem] px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-6 md:pb-3">
```

## Repo conventions to follow

- Custom properties that must drive the shell are set on `documentElement`
  (see the pre-paint theme class in `main.tsx`). `--keyboard-inset` follows
  that pattern.
- `mobile.css` sits outside `@layer` on purpose so it beats Tailwind
  utilities; keep new rules there, not in a layer.
- Hooks live in `src/lib/` (`use-console-queries.ts`, `use-session-repair.ts`).
  Name and place accordingly.
- The comment in `mobile.css` points at the exact mechanism; rewrite the
  stale `components/mobile/viewport-insets.tsx` reference to
  `lib/viewport-insets.ts` when you land this.

## Steps

1. Create `src/lib/viewport-insets.ts` with the hook from **Target §1**.
2. `src/App.tsx`: import and call `useViewportInsets()`; add `app-frame` to
   the root (line ~957) and `mobile-tab-bar` to the nav (line ~1099).
3. `src/App.tsx:709`: extend the theme effect to update the `theme-color`
   metas (Target §3).
4. `index.html`: replace the viewport and theme-color metas (Target §4).
5. `src/styles/whirl/mobile.css`: add the `touch-action` block; fix the stale
   comment reference.
6. `src/styles/whirl/workbench.css`: add `overscroll-behavior: contain` to
   `.wb-scroll`.
7. `chat-view.tsx`: add the safe-area bottom padding to the dock.
8. Run `npm run check`.

## Boundaries

- Do NOT rewrite `mobile.css`; the selectors are correct, the markup was
  missing. Restore the contract.
- Do NOT add `user-scalable=no` or `maximum-scale=1` — inputs are already
  16px on touch via `.field-text`.
- Do NOT gate `touch-action` by user agent or width; the capability media
  query is the gate.
- Do NOT set `touch-action: none` on any scrollable surface.
- Do NOT change the theme colours themselves; only the `theme-color` values
  that mirror them.
- This plan is verifiable only partly from code; the hardware steps below are
  required before calling it done.

## Verification

- **Mechanical**: `npm run check` passes. `grep -rn "app-frame\|mobile-tab-bar"
  src/` shows `App.tsx` now sets both and `mobile.css` matches.
- **éme Check (desktop)**: open DevTools mobile emulation; the shell still
  fills the viewport and the tab bar shows. No visual regression on desktop —
  `app-frame`'s height override is behind `(hover: none) and (pointer: coarse)`,
  so desktop is untouched.
- **Real hardware (required)**: connect a phone, open the dev server by LAN
  IP, use Safari Web Inspector (iOS) / `chrome://inspect` (Android):
  - Focus the composer: the tab bar hides and the composer stays above the
    keyboard (iOS especially — this is the bug).
  - Drag down from the top of a conversation: no pull-to-refresh, no page
    rubber-band; the transcript's own bounce still works.
  - On a notched device in landscape and portrait: the send button clears the
    home indicator; the transcript does not slide under the notch.
  - Tap a sidebar row and a tab: feedback fires on touch-down, not after a
    delay.
  - Toggle dark mode and check the status bar colour follows.
- **Done when**: the keyboard no longer covers the composer on iOS, overscroll
  is locked, the tab bar hides with the keyboard, theme-color matches in both
  modes, and the desktop layout is unchanged.
