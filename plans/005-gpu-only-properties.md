# 005 — Animate GPU-only properties (no layout animation)

- **Status**: TODO
- **Commit**: f509488
- **Severity**: MEDIUM
- **Category**: Performance
- **Estimated scope**: 3 files (`notifications-center.tsx`, `model-select.tsx`, `system-panel.tsx`, `conversation-nav.tsx`), ~25 lines

## Problem

Three places animate **layout** properties — `left` and `width` — which
trigger layout, paint and composite on every frame. Emil: "Only animate
transform and opacity. These properties skip layout and paint, running on the
GPU. Animating padding, margin, height, or width triggers all three rendering
steps." A fourth uses `transition: all`.

**(a) Switch knob animates `left`.**

```tsx
// src/components/whirl/pages/notifications-center.tsx:195-197 — current
<span className={cn('relative h-4 w-7 shrink-0 rounded-full transition-colors duration-150', checked ? 'bg-primary' : 'bg-muted')}>
  <span className={cn('absolute top-0.5 size-3 rounded-full bg-background transition-[left] duration-150', checked ? 'left-3.5' : 'left-0.5')} />
</span>
```

The track is `w-7` (28px), the knob `size-3` (12px), `left-0.5` = 2px,
`left-3.5` = 14px; the travel is 12px.

**(b) Context-usage bar animates `width`.**

```tsx
// src/components/whirl/model-select.tsx:189 — current
<div className={cn('h-full rounded-full bg-foreground transition-[width] duration-500', context.percent >= 90 && 'bg-destructive')} style={{ width: `${context.limit > 0 ? context.percent : 0}%` }} />
```

**(c) System gauges animate `width`.**

```tsx
// src/components/whirl/system-panel.tsx:116-120 — current
<div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
  <div
    className={cn('h-full rounded-full bg-foreground transition-[width] duration-500', percent >= 90 && 'bg-destructive')}
    style={{ width: `${Math.min(100, percent)}%` }}
  />
</div>
```

**(d) The conversation rail tick uses `transition: all` and animates `width`.**

```tsx
// src/components/whirl/conversation-nav.tsx:82 — current
<span className={cn('block h-0.5 rounded-full transition-all duration-200 ease-out', index === active ? 'w-4 bg-foreground' : 'w-2.5 bg-muted-foreground/40 group-hover/nav:w-4 group-hover/nav:bg-muted-foreground')} />
```

## Target

Same visual result, all four driven by `transform` (plus colour), which runs
on the compositor. `500ms` stays only on the two progress bars where the
budget allows (they are not UI interaction feedback); the rail tick stays at
200 ms. Use the strong `ease-out` from plan 001.

```tsx
// notifications-center.tsx — knob: fixed position, translate instead of left
<span className="relative h-4 w-7 shrink-0 rounded-full transition-colors duration-150">
  <span
    className={cn('absolute top-0.5 left-0.5 size-3 rounded-full bg-background transition-transform duration-150 ease-out', checked ? 'translate-x-3' : 'translate-x-0')}
  />
</span>
```

```tsx
// model-select.tsx — fill a full-width track and scaleX it
<div className={cn('h-full w-full origin-left rounded-full bg-foreground transition-transform duration-500 ease-out', context.percent >= 90 && 'bg-destructive')}
  style={{ transform: `scaleX(${context.limit > 0 ? Math.min(1, Math.max(0, context.percent / 100)) : 0})` }} />
```

```tsx
// system-panel.tsx — same treatment
<div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
  <div
    className={cn('h-full w-full origin-left rounded-full bg-foreground transition-transform duration-500 ease-out', percent >= 90 && 'bg-destructive')}
    style={{ transform: `scaleX(${Math.min(1, Math.max(0, percent / 100))})` }}
  />
</div>
```

```tsx
// conversation-nav.tsx — fixed 16px track, inner bar scales (10/16 = 0.625)
<span className="relative block h-0.5 w-4 overflow-hidden rounded-full">
  <span
    className={cn(
      'block h-full w-full origin-left rounded-full transition-[transform,background-color] duration-200 ease-out',
      index === active
        ? 'scale-x-100 bg-foreground'
        : 'scale-x-[0.625] bg-muted-foreground/40 group-hover/nav:scale-x-100 group-hover/nav:bg-muted-foreground',
    )}
  />
</span>
```

## Repo conventions to follow

- The app already prefers GPU properties everywhere else —
  `transition-[background-color,scale]`, `active:scale-[0.96]`,
  `group-open:*:rotate-90`. This plan brings the four stragglers in line.
- Tailwind's `translate-x-3` / `scale-x-*` utilities compose via
  `--tw-translate-x` / `--tw-scale-x`; the resulting `transform` is still a
  single compositor property. `origin-left` is required for a `scaleX` fill so
  it grows from the left, not the centre.
- Keep `overflow-hidden rounded-full` on the track; the scaled child needs it
  to keep the rounded caps.

## Steps

1. `notifications-center.tsx`: replace the knob span (line ~196) with the
   `translate-x-3` / `translate-x-0` version. Remove `transition-[left]` and
   the `left-*` classes.
2. `model-select.tsx`: replace the bar (line 189) with the `w-full
   origin-left transition-transform` version and clamp the scale to `0..1`.
3. `system-panel.tsx`: replace the gauge child (line ~118) the same way.
4. `conversation-nav.tsx`: replace the tick span (line ~82) with the
   track + inner-scale version. Delete `transition-all`.
5. Run `npm run check`.

## Boundaries

- Do NOT change colours, sizes, radii, or the 500 ms duration.
- Do NOT clamp away the existing `percent >= 90 → bg-destructive` logic.
- Do NOT convert the `conversation-nav` rail to a different interaction; only
  the tick's internals change.
- Do NOT touch `Gauge`'s label/detail markup or the chart.
- If a bar's parent is not `overflow-hidden` (target may have drifted), STOP
  and report.

## Verification

- **Mechanical**: `npm run check` passes. `grep -rn "transition-\[width\]\|transition-\[left\]\|transition-all"
  src/` returns nothing (except intentionally excluded files if any).
- **Feel check**: start `npm run dev`.
  - Open **Notifications** and toggle "Only when the tab is hidden": the knob
    slides smoothly; the track colour still transitions.
  - Open the model picker on a session with context usage: the context bar
    fills from the left.
  - Open **System**: CPU/Memory/Disk gauges fill from the left.
  - Open a long conversation and scroll: the left rail's active tick grows
    from the left under the pointer and shrinks back.
  - DevTools → Performance, record while toggling the switch: the frame
    should show Composite only, no Layout / Recalculate Style spikes.
- **Done when**: no layout properties are animated, visuals are identical, and
  `npm run check` passes.
