# 006 — Consistent, subtle press feedback

- **Status**: TODO
- **Commit**: f509488
- **Severity**: MEDIUM
- **Category**: Feedback
- **Estimated scope**: ~10 files, class-only edits

## Problem

Press feedback exists but is inconsistent. Primary buttons correctly do
`active:scale-[0.96]` with `transition-[background-color,scale]`, but:

- The composer's icon buttons scale **too far** (`0.92`/`0.94`) — Emil's
  guidance is subtle, `0.95–0.98`. A `0.92` press reads as a bounce, not a
  click.
- Every sidebar row, chat row, run row, tab and the mobile tab bar has **no
  press state at all** — they only change colour on hover, so on touch there
  is no feedback until the action completes.
- Menu items (`session-menu`, `tab-menu`, `search-palette`, `model-select`,
  `workspace-menu`, home chips, composer attach menu) have no pressed state,
  even though the design system already defines `--accent-pressed` for
  exactly this.
- Hover-revealed icon buttons (`MessageActionButton`) and the theme / logout
  / bell / plus / dots icon buttons have no press feedback.

Emil: "Buttons must feel responsive. Add `transform: scale(0.97)` on `:active`
… making the UI feel like it is truly listening to the user. Applies to any
pressable element. The scale should be subtle (0.95–0.98)."

Important interaction detail: an `:active` transform is **instant unless the
element's `transition-property` includes `scale`** (or `transform`). Rows that
only transition colours will snap when scaled, which is worse than no press
state. Every element touched here must have `scale` in its transition list.

## Target

One ladder, applied by element kind. Colours stay as they are; only the
transition property list and the `:active` state change.

| Kind | Press state | Transition list |
| --- | --- | --- |
| Primary / text button | `active:scale-[0.96]` | `transition-[background-color,scale]` |
| Icon button (square/round) | `active:scale-[0.96]` | `transition-[background-color,color,scale]` |
| Full-width row (sidebar, chat, run) | `active:scale-[0.98]` | `transition-[color,background-color,scale]` |
| Tab / small chip | `active:scale-[0.98]` | `transition-[color,background-color,scale]` |
| Menu item | `active:bg-(--accent-pressed)` | leave colour transition as-is |

### A. Normalise the over-strong scales

| File | Current | Target |
| --- | --- | --- |
| `composer.tsx:234` (attach) | `active:scale-[0.92]` | `active:scale-[0.96]` |
| `composer.tsx:254` (stop) | `active:scale-[0.94]` | `active:scale-[0.96]` |
| `composer.tsx:265` (send) | `active:scale-[0.94]` | `active:scale-[0.96]` |
| `thread/thread-view.tsx:159` (jump to latest) | `active:scale-[0.94]` | `active:scale-[0.96]` |
| `chat-view.tsx:315` (mobile back) | `active:scale-[0.94]` | `active:scale-[0.96]` |

### B. Add press to rows and tabs (currently none)

```tsx
// src/components/whirl/sidebar.tsx — SidebarRow (line ~380)
'group/row flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] transition-[color,background-color,scale] duration-100 active:scale-[0.98]'

// src/components/whirl/sidebar.tsx — RunRow wrapper (line ~423)
cn('group/row relative flex w-full min-w-0 items-center rounded-md transition-[color,background-color,scale] duration-100 active:scale-[0.98]', active ? 'bg-accent' : 'hover:bg-accent')

// src/components/whirl/chat-row.tsx — row button (line ~28)
'flex h-8 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md pr-8 pl-2.5 text-left text-[13.5px]/4 font-medium transition-[color,background-color,scale] duration-100 active:scale-[0.98]'

// src/components/whirl/tabs/horizontal-tabs.tsx — tab element (line ~135)
'group/tab relative flex shrink-0 items-center rounded-md transition-[color,background-color,scale] duration-100 active:scale-[0.98]'
```

Rows are nested inside scroll containers; a `0.98` scale on a full-width row
is imperceptible as a "zoom" but registers as a press.

### C. Mobile tab bar (App.tsx ~1109)

```tsx
// each of the three buttons — add press and transition
className={cn(
  'grid min-h-12 justify-items-center content-center gap-0.5 rounded-md text-[11px] transition-[color,background-color,scale] duration-150 active:scale-[0.96]',
  route.view === view ? 'text-foreground' : 'text-muted-foreground',
)}
```

### D. Menu items — use the existing pressed token

`--accent-pressed` is defined in `globals.css` but never used. Apply it to
menu rows so a press reads as "pressed in", not "stuck hovering". Add
`active:bg-(--accent-pressed)` to each menu-item class:

| File | Component |
| --- | --- |
| `session-menu.tsx:~189` | `MenuItem` |
| `tabs/horizontal-tabs.tsx:~233` | `TabMenuItem` |
| `search-palette.tsx:~105` | result rows |
| `model-select.tsx:~110` | model option rows (the `hover:bg-accent` wrapper) |
| `home-view.tsx:~219,~249` | `ProjectChip` / `KindChip` items |
| `workspace-menu.tsx:~93` | workspace option rows |
| `composer.tsx:~281` | `MenuItem` (attach menu) |
| `notifications-center.tsx:~114` | notification rows |
| `pages/history-view.tsx` | filter rows, if they use `hover:bg-accent` |

### E. Hover-revealed icon buttons

```tsx
// src/components/whirl/message-action-button.tsx:25
className="grid size-7 cursor-pointer place-items-center rounded-md text-muted-foreground transition-[color,background-color,scale] duration-150 hover:bg-black/[0.05] hover:text-foreground active:scale-[0.96] dark:hover:bg-white/[0.06]"
```

Apply the same to the sidebar footer theme/logout buttons, the bell, the
"+" / "⋯" tab buttons, the system-panel close button, and the run-summary
"Changes" pill — each currently `transition-colors duration-150` with no
`active:`.

## Repo conventions to follow

- The established primary-button recipe is
  `transition-[background-color,scale] duration-150 hover:bg-(--primary-hover) active:scale-[0.96]`.
  Copy it; do not invent a new duration or scale for that class of button.
- The app's `--accent-pressed` token exists precisely for menu-press
  (`globals.css` comment: "Pressing releases it back toward whatever it sits
  on rather than digging further in"). Use it rather than `bg-accent/70`.
- Do not add a shared `.wb-press` class: existing elements have different
  transition lists, and a shorthand `transition` would clobber their colour
  transitions. Per-element utilities are the correct tool here.

## Steps

1. Apply table **A** (five scale normalisations).
2. Apply block **B** (three rows + tab strip).
3. Apply block **C** (mobile tab bar).
4. Apply block **D** (menu items — `active:bg-(--accent-pressed)`).
5. Apply block **E** (icon buttons).
6. Run `npm run check`.

## Boundaries

- Do NOT change any colour on `:hover` or the resting state.
- Do NOT add `active:` to `disabled` controls in a way that scales them while
  disabled — disabled buttons already use `disabled:pointer-events-none` /
  `disabled:opacity-*`; leave those alone.
- Do NOT scale full-page or card surfaces, only controls/rows.
- Do NOT touch the composer textarea or any input.
- If a listed line no longer matches (file drifted), match by component name
  instead and note it; do not skip silently.

## Verification

- **Mechanical**: `npm run check` passes. `grep -rn "active:scale-\[0.92\]\|active:scale-\[0.94\]" src/`
  returns nothing.
- **Feel check**: start `npm run dev`.
  - Press and hold the composer send button: it compresses by ~4 % and eases
    back on release over ~150 ms.
  - On a touch device or DevTools touch emulation, tap a sidebar row and the
    mobile tab bar: each should visibly (but subtly) compress — this is the
    feedback that was missing on touch.
  - Open the row context menu and press an item: it darkens to the pressed
    tone, distinct from hover.
  - DevTools → Animations at 10%: each press is a clean scale, no snap-then-
    scale.
- **Done when**: every control/row in the list presses subtly and consistently,
  no `0.92`/`0.94` scales remain, and `npm run check` passes.
