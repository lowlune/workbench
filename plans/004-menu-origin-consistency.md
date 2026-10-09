# 004 — Origin-aware menus + consistent entrance

- **Status**: TODO
- **Commit**: f509488
- **Severity**: MEDIUM
- **Category**: Origin, physicality & cohesion
- **Estimated scope**: 2 files (`session-menu.tsx`, `horizontal-tabs.tsx`), ~40 lines

## Problem

Two issues, both about menus growing from the wrong place:

**(a) The conversation context menu scales from its own centre.** It is
positioned at the click point but `zoom-in-95` uses the default
`transform-origin: center`, so it appears to inflate out of its middle instead
of out of the pointer. Emil: "Popovers should scale in from their trigger, not
from center."

```tsx
// src/components/whirl/session-menu.tsx:130-139 — current
<div
  aria-hidden="true"
  ...
  className="fixed inset-0 z-[129] bg-background/25 backdrop-blur-sm animate-in fade-in duration-150"
/>
<div
  role="menu"
  aria-label="Conversation actions"
  onPointerDown={(event) => event.stopPropagation()}
  onContextMenu={(event) => event.preventDefault()}
  style={{ left: state.x, top: state.y }}
  className="raised fixed z-[131] w-56 rounded-xl bg-popover p-1 text-[13px] ring-1 ring-border animate-in fade-in zoom-in-95 duration-150"
>
```

The click coordinates are already known in `openSessionMenuAt` but thrown
away after clamping:

```tsx
// src/components/whirl/session-menu.tsx:82 — current
setState({
  session,
  x: Math.max(8, Math.min(x, window.innerWidth - 240)),
  y: Math.max(8, Math.min(y, window.innerHeight - 320)),
});
```

**(b) The tab-strip options menu fires with no entrance at all**, while the
row menu fades/zooms — a cohesion mismatch between two menus in the same
product.

```tsx
// src/components/whirl/horizontal-tabs.tsx — current (tab options popup)
<div
  role="menu"
  aria-label="Tab options"
  className="raised fixed z-[131] w-48 rounded-xl bg-popover p-1 text-[13px] ring-1 ring-border"
  style={{ left: menu.x, top: menu.y }}
>
```

## Target

Menus scale out of the click point, both menus share one entrance, and both
use the strong token curve (plan 001) via Tailwind's `ease-out`, which
tw-animate reads through `--tw-ease`.

**Session menu** — carry the origin through state and apply it:

```tsx
// src/components/whirl/session-menu.tsx — state type
const [state, setState] = useState<{
  session: Session; x: number; y: number; originX: number; originY: number;
} | null>(null);
```

```tsx
// src/components/whirl/session-menu.tsx — openSessionMenuAt
const left = Math.max(8, Math.min(x, window.innerWidth - 240));
const top = Math.max(8, Math.min(y, window.innerHeight - 320));
setState({ session, x: left, y: top, originX: x - left, originY: y - top });
elevate(el || null);
```

```tsx
// src/components/whirl/session-menu.tsx — popup
style={{ left: state.x, top: state.y, transformOrigin: `${state.originX}px ${state.originY}px` }}
className="raised fixed z-[131] w-56 rounded-xl bg-popover p-1 text-[13px] ring-1 ring-border animate-in fade-in zoom-in-95 ease-out duration-150"
```

**Tab menu** — same entrance and origin. `openMenuAt` already receives the raw
click/trigger coordinates; store the offset the same way:

```tsx
// src/components/whirl/horizontal-tabs.tsx — state type
const [menu, setMenu] = useState<{ x: number; y: number; originX: number; originY: number } | null>(null);

function openMenuAt(x: number, y: number) {
  const left = Math.max(8, Math.min(x, window.innerWidth - 200));
  const top = Math.max(8, Math.min(y, window.innerHeight - 160));
  setMenu({ x: left, y: top, originX: x - left, originY: y - top });
}
```

```tsx
// src/components/whirl/horizontal-tabs.tsx — popup
style={{ left: menu.x, top: menu.y, transformOrigin: `${menu.originX}px ${menu.originY}px` }}
className="raised fixed z-[131] w-48 rounded-xl bg-popover p-1 text-[13px] ring-1 ring-border animate-in fade-in zoom-in-95 ease-out duration-150"
```

Both menus are **occasional** (right-click / overflow), so a 150 ms
fade+zoom is the right tier. `zoom-in-95` (scale `0.95`), never `scale(0)`.

## Repo conventions to follow

- `origin-(--transform-origin)` is the app's convention for Base UI
  anchored surfaces (`ui/popover.tsx`, `ui/tooltip.tsx`). These two menus are
  hand-positioned at a pointer, not Base UI-positioned, so they set a literal
  `transformOrigin` in `style`. That is the correct exception, not a
  divergence.
- The row menu already uses the `animate-in fade-in zoom-in-95 duration-150`
  recipe; copy it verbatim into the tab menu so the two cannot drift.
- `ease-out` sets `--tw-ease`, which tw-animate's `--animate-in` shorthand
  reads (`var(--tw-ease, ease)`). With plan 001 landed, this resolves to the
  strong `cubic-bezier(0.23, 1, 0.32, 1)`.

## Steps

1. `session-menu.tsx`: widen the `state` type with `originX`/`originY`.
2. `session-menu.tsx`: compute `left`/`top` once in `openSessionMenuAt`,
   store the origin offsets, and keep the existing `setState` shape otherwise.
3. `session-menu.tsx`: add `transformOrigin` to the popup `style` and add
   `ease-out` to its class list.
4. `horizontal-tabs.tsx`: widen the `menu` state type, and rewrite
   `openMenuAt` to compute and store the origin offsets.
5. `horizontal-tabs.tsx`: add `transformOrigin` to the popup `style` and add
   `animate-in fade-in zoom-in-95 ease-out duration-150` to its class list.
6. Run `npm run check`.

## Boundaries

- Do NOT touch `elevate`/`resetElevated`, the close listeners, the backdrop
  or menu items.
- Do NOT change the clamping margins (`- 240`, `- 320`, `- 200`, `- 160`) —
  they are sized to the menu widths.
- Do NOT convert either menu to Base UI Popover/Menu.
- Do NOT add `ease-out` to shared `ui/*` popups/dialogs in this plan; that is
  a separate cohesion pass.
- If `openMenuAt`'s parameter names differ (e.g. it takes a rect), STOP and
  report rather than guessing.

## Verification

- **Mechanical**: `npm run check` passes. `grep -n "transformOrigin"
  src/components/whirl/session-menu.tsx src/components/whirl/tabs/horizontal-tabs.tsx`
  shows both. `grep -n "zoom-in-95" src/components/whirl/tabs/horizontal-tabs.tsx`
  shows the entrance.
- **Feel check**: start `npm run dev`.
  - Right-click a conversation row near the bottom-right of the sidebar: the
    menu should grow out of the cursor, not out of its centre.
  - Right-click a tab in the strip: the menu now fades/zooms in (it did not
    before) and from the pointer.
  - Right-click near the right edge so the menu clamps leftwards: the origin
    must stay under the cursor (this is what the `originX = x - left` math
    buys).
  - DevTools → Animations at 10%: confirm the scale starts at 0.95 and grows
    from the origin corner nearest the pointer.
- **Done when**: both menus scale from the pointer, share one entrance, and
  `npm run check` passes.
