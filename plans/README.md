# Workbench — UI/UX polish plans (motion & interaction)

Written from an audit of the current Workbench console against Emil Kowalski's
design-engineering skills (`emil-design-eng`, `animate`, `review-animations`,
`improve-animations`, `find-animation-opportunities`, `apple-design`,
`mobile-native`). Read-only: these plans change motion and interaction
properties; they do **not** redesign the UI.

**Commit at audit time:** `f509488`
**Source:** `emilkowalski/skill` (skills/animate, apple-design, mobile-native, …)

## Zhrnutie (SK)

Workbench už je na vysokej úrovni — má `active:scale` na tlačidlách,
`transition-[background-color,scale]` namiesto `transition: all`,
`transform-origin: var(--transform-origin)` na popoveroch, `coarse:` variant
pre dotykové zariadenia a `prefers-reduced-motion` na viacerých CSS
keyframes. Audit preto našiel **doladenie, nie prerábanie**.

Najväčšie nálezy, podľa priority:

1. **Toasty nemajú žiadnu animáciu** — objavia sa a zmiznú skokom (jarring).
   Najvyšší UX dopad.
2. **Mobilný layout má mŕtvy kód** — `mobile.css` cieli `.app-frame`,
   `.mobile-tab-bar`, `[data-keyboard]`, `--keyboard-inset`, ktoré v kóde
   neexistujú. Klávesnica prekryje composer, pull-to-refresh sa spúšťa
   počas chatu, tab bar sa neschová. Reálne bugy.
3. **⌘K paleta sa animuje** — pri klávesnicou spúšťanej akcii (100+/deň) má
   byť otvorenie okamžité (Raycast princíp).
4. **Animujú sa layoutové vlastnosti** — `transition-[left]` na toggle,
   `transition-[width]` na progress baroch, `transition-all` na tab
   markeroch. Majú ísť cez `transform`.
5. **tw-animate-css nerešpektuje `prefers-reduced-motion`** — dialogy,
   popovery, tooltipy a menu animujú transformácie aj pri zníženom pohybe.
6. **Chýbajúce easing/duration tokeny** — krivky sú ručne napísané na 3
   miestach, Tailwind `ease-out` je slabý built-in.

Plány sú nižšie, zoradené podľa leverage (dopad ÷ úsilie). Každý plán je
samostatný a spustiteľný agentom bez kontextu tohto auditu.

## How to use these plans

Each file is self-contained (per `improve-animations/PLAN-TEMPLATE.md`):
exact file paths, verbatim current code, exact target values, ordered steps,
scope boundaries and a feel-check verification. An executor with no context
should be able to run any one plan alone.

Rules for every executor:

1. **Preserve existing user changes.** The working tree already has
   uncommitted edits (`git status`); never revert or stash them.
2. **Motion properties only.** Do not change markup structure, copy, layout
   or business logic unless a step explicitly says so.
3. **No new dependencies.** Everything here is CSS or plain React.
4. **Extend tokens, don't fork them.** After plan 001 exists, use
   `var(--ease-out)` / `var(--ease-in-out)` / `var(--ease-drawer)`; never
   hand-type a new bezier.
5. **Reduced motion ships with the animation**, not as a follow-up.
6. **If a step doesn't match the code** (drift since `f509488`), STOP and
   report instead of improvising.

## Findings table

Ordered by leverage. Severity: **HIGH** = feel-breaking / real bug;
**MEDIUM** = noticeably off; **LOW** = polish.

| # | Sev | Category | Location | Finding | Plan |
| --- | --- | --- | --- | --- | --- |
| 1 | HIGH | Purpose/frequency | `search-palette.tsx:73` | ⌘K palette plays a zoom+fade entrance for a keyboard action used 100+/day | 003 |
| 2 | HIGH | Missed opportunity | `App.tsx:262,1254` | Toasts appear and vanish instantly — no enter/exit, no spatial story | 002 |
| 3 | HIGH | Bug (mobile) | `mobile.css:22,40,56` | Selectors target `.app-frame`/`.mobile-tab-bar`/`[data-keyboard]`, none exist → keyboard inset, overscroll lock and tab-bar hide are all dead | 008 |
| 4 | MEDIUM | Performance | `notifications-center.tsx:196` | Toggle knob animates `left` (layout property) | 005 |
| 5 | MEDIUM | Performance | `model-select.tsx:189`, `system-panel.tsx:118` | Progress bars animate `width` (layout property) | 005 |
| 6 | MEDIUM | Performance | `conversation-nav.tsx:82` | `transition-all` plus animated `width` on the rail tick | 005 |
| 7 | MEDIUM | Accessibility | `node_modules/tw-animate-css` via `ui/*.tsx` | tw-animate-css has no `prefers-reduced-motion`; dialogs/popovers/tooltips/menus move regardless | 009 |
| 8 | MEDIUM | Origin/physicality | `session-menu.tsx:138`, `horizontal-tabs.tsx` | Context menu scales from its own centre, not the click point; tab menu doesn't animate at all (mismatch) | 004 |
| 9 | MEDIUM | Missed opportunity | `composer.tsx`, `chat-view.tsx`, `thread-view.tsx` | Attachments, queued card, run summary, interaction cards and banners appear/disappear with no bridge | 007 |
| 10 | MEDIUM | Cohesion | `globals.css` | No shared easing/duration tokens; three hand-typed beziers; built-in `ease-out` too weak | 001 |
| 11 | MEDIUM | Feedback | `composer.tsx:234` + sidebar/mobile rows | Press feedback inconsistent (`0.92` here, none on rows/mobile nav) | 006 |
| 12 | LOW | Missed opportunity | `thread/activity.tsx`, `tool-cards.tsx` | `<details>` tool disclosures snap open | 010 |
| 13 | LOW | Cleanup | `globals.css` | Large dead Whirl blocks (`.t-page-slide`, `.tiptap-prose`, `.platinum-*`, `.oss-orbit`, `.sidebar-glide`, `lib/accent.ts`/`lib/tint.ts` tokens) | 011 |
| 14 | LOW | Polish | `loading-ui/dots-ring.tsx`, `composer.tsx` | Per-instance `<style>` tag; `active:scale-[0.92]`; toast `truncate` | 012 |

## Deliberately NOT proposed (rejected candidates)

Emil's `find-animation-opportunities` requires listing what was considered
and rejected, so the audit is a filter and not a wishlist:

- **Route/view switching (`home`→`history`→`usage`)**: no page-slide
  proposed. It is core navigation seen constantly; `.t-page-slide` in
  globals.css is dead and should be pruned (plan 011), not revived.
- **Sidebar / tab-strip / list-row hover**: colour-only today, which is
  correct. No motion is added — tens/day, colour is enough.
- **Tab reorder drag → spring/layout animation**: the strip is high
  frequency and HTML5 DnD is fine. A spring here would cost more than it
  buys.
- **Spinners (`animate-spin`, `DotsRing`)**: kept as-is for perceived
  performance; only their reduced-motion behaviour is fixed (plan 009).
- **Streamed-character fade (`[data-sd-animate]`)**: already handled and
  reduced-motion-gated in globals.css; not in the active render path.
- **`RunSummary` 20 s auto-expiry**: the 20 s budget is a product decision,
  not a motion bug. Only the removal transition is proposed (plan 007).

## Execution order

Dependencies matter; do them top-to-bottom unless a plan says otherwise.

1. **001 — motion tokens** (foundation; every later plan references them).
2. **008 — mobile-native fixes** (real bugs; independent of tokens).
3. **002 — toast motion**.
4. **003 — command palette instant**.
5. **005 — GPU-only properties**.
6. **004 — menu origin + consistency**.
7. **009 — reduced motion / transparency**.
8. **007 — surface entrances**.
9. **006 — press feedback**.
10. **010 — disclosure motion**.
11. **012 — misc polish**.
12. **011 — dead CSS audit** (last).

## Status

| # | Plan | Severity | Status |
| --- | --- | --- | --- |
| 001 | Shared motion tokens | MEDIUM | TODO |
| 002 | Toast enter/exit motion | HIGH | TODO |
| 003 | Command palette opens instantly | HIGH | TODO |
| 004 | Menu origin + consistency | MEDIUM | TODO |
| 005 | GPU-only properties | MEDIUM | TODO |
| 006 | Consistent press feedback | MEDIUM | TODO |
| 007 | Surface entrances | MEDIUM | TODO |
| 008 | Mobile-native fixes | HIGH | TODO |
| 009 | Reduced motion / transparency | MEDIUM | TODO |
| 010 | Disclosure motion | LOW | TODO |
| 011 | Dead Whirl CSS audit | LOW | TODO |
| 012 | Misc polish | LOW | TODO |

Update a plan's row here to DONE (or note partial) as it lands, and re-stamp
its `Commit:` line during `improve-animations reconcile`.
