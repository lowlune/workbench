# 014 — Persistent chat tools rail: Tasks, Notes, Skills, AGENTS.md

- **Status**: TODO
- **Commit**: 67d2581
- **Severity**: HIGH
- **Category**: Information architecture, in-context tools, user agency
- **Estimated scope**: 8–12 files, ~400–650 lines plus tests

## Brief

In ChatView, replace the floating top-right task-count popover with a small, persistent, collapsible tools rail. Its default expanded state always shows Tasks, including an honest empty/loading state. Below the task content, provide switchable **Notes**, **Skills**, and **AGENTS.md** views. A discreet control collapses/hides the rail; the user can reopen it. Preserve the transcript, composer, mobile behavior, existing AGENTS.md editor, and task/run behavior.

## Current implementation and data

- `src/components/whirl/chat-view.tsx:318–333`: top chrome renders `TaskListPanel` as a pill/popover; AGENTS.md currently appears only as a conditional pill when instructions are active.
- `src/components/whirl/task-list-panel.tsx`: renders current `session.activeRun?.todos` or `session.todos` and returns `null` when none. This is why no persistent task surface exists outside a run.
- `src/components/whirl/agents-md-dialog.tsx`: existing editor for applicable global/project/nested instruction files; opened through `agentsTarget` in `App.tsx`. Reuse it; do not build a second editor.
- `src/lib/workbench.ts` and `server/control.mjs` expose protected `/agents-md` read/save functionality. Keep these protections.
- Pi skills are discovered by Pi’s `DefaultResourceLoader`/resource pipeline. Workbench’s Pi runner uses `noExtensions: true`; the current v2 API has no Skills metadata endpoint. Inspect pinned Pi `0.87.1` APIs before implementing discovery. Skills should be read-only metadata in this plan; no installation/editing.
- “Notes” has no current durable data model/API/UI. Define a per-conversation persistent model; component state/localStorage alone is insufficient.
- Current worktree already contains unrelated user changes. Preserve them; do not reset/stash or absorb unrelated tab/server edits into implementation commits.

## Product decisions

1. **Default per chat: expanded rail, Tasks selected.** Tasks stay visible when empty: show a concise “Tasks from the agent will appear here” state, not a missing popover.
2. **Four tool views:** Tasks, Notes, Skills, AGENTS.md. The view switch is compact, accessible, with one unambiguous selected state. Switching is immediate.
3. **Hide/show:** a minimalist icon control at the rail header with accessible labels “Hide chat tools” / “Show chat tools”, `aria-expanded` and `aria-controls`. Persist the choice per conversation in localStorage; new chats default expanded. It is presentation preference only.
4. **Desktop:** in-flow right rail attached to the chat panel, fixed ~18rem unless a genuinely usable accessible resize mechanism is justified. Transcript gets remaining space. Rail never overlays transcript/composer. At narrow widths collapse or use an existing Base UI sheet.
5. **Mobile:** preserve full transcript width. Open tools using a compact control and Base UI sheet/dialog; respect safe areas, keyboard, focus trapping/return, Escape and scroll locking.
6. **Tasks:** show progress, readable wrapped task labels and accurate pending/in-progress/complete/failed/cancelled states; scroll long plans. Never fabricate tasks or hide the panel when no run is active.
7. **Notes:** chat-scoped Markdown/plain text, durable across refresh/devices. Autosave with explicit Saved/Saving/Unsaved/Error states, revision conflict protection, bounded size and safe chat switching. In this plan, notes are **not automatically inserted into model prompts**; explain that to avoid hidden prompt side effects.
8. **Skills:** show only factual metadata available to the active runtime/workspace (name, description, source/scope when safe). Read-only. No install/edit action. If supported discovery cannot be implemented safely, show an honest unavailable/empty state; never mock skills.
9. **AGENTS.md:** show applicability/existence of global/project/nested files. “Edit instructions” opens existing `AgentsMdDialog` for active project/path. Do not duplicate editing UI.
10. Notes/Skills/AGENTS views stay usable with no run/tasks. Scope all data to the current session/project correctly.

## Layout and visual direction

- This is a tools rail integrated into the chat surface, not a larger floating badge. One restrained surface, hairline boundary, compact toolbar, independent content scroll.
- Desktop: rail header with title/progress/collapse; tool switcher beneath; active content below. Tasks have no extra card per row.
- Use existing Workbench neutral/light/dark tokens, typography, radius and `--ease-*`/`--duration-*` tokens. Keep task state legible by text/icon and not color alone.
- No decorative gradient, nested card stacks, or new motion dependency.
- Collapse changes geometry; prefer immediate responsive reflow over animating width/grid tracks. If an entry/exit is introduced, it must have a clear purpose, use existing tokens, stay under 250ms, and include reduced-motion handling. Do not animate frequent view switches.

## Data/API design required before implementation

### Notes

Add durable store-backed notes keyed by conversation ID, with idempotent migration: `conversation_id` PK/FK, `content`, `revision`, `updated`. Add GET/PUT endpoint and revision conflict (`409`), verify conversation ownership/existence using existing lookup, cap UTF-8 content at a defined size (recommend 100 KB), and do not put note content into overview/bootstrap or run prompts. Add tests for create/read/update/restart/conflict/size/not-found.

### Skills

Trace Pi `DefaultResourceLoader`/session skill APIs at pinned version. Add read-only metadata discovery using the same workspace, agent directory, resource/trust rules as actual runs. Do not load extension code just to enumerate; do not scan arbitrary filesystem paths. Add tests using fixtures or supported Pi API. If metadata cannot be obtained faithfully, expose a clear unavailable/empty state and document the constraint instead of inventing values.

## Ordered implementation steps

1. Read current `App.tsx`, `ChatView`, `TaskListPanel`, `AgentsMdDialog`, store/migrations/routes and pinned Pi skill/resource APIs. Confirm desktop breakpoints and top chrome. If a premise is false, update this plan before coding.
2. Add tested tool-view and per-chat collapse state (`tasks | notes | skills | agents`); new conversations default to Tasks + expanded, and preferences are keyed by conversation ID without leaking across chats.
3. Implement durable Notes API/store/migration/tests. Fetch note only when its panel view is selected; debounce writes; preserve draft through errors/conflicts/chat switching. Never prompt-inject automatically.
4. Implement safe Skills metadata endpoint from supported runtime resource discovery. Metadata-only and read-only. If no supported safe path, return unavailable explicitly rather than mock results.
5. Refactor task-list rendering into an always-present Tasks view; preserve status semantics; add empty/loading/error states.
6. Build Notes view with editor, size limit, save state, conflict handling and explanatory prompt-scope copy.
7. Build Skills view with actual name/description/source metadata, loading/empty/unavailable/error states, no installation controls.
8. Build AGENTS.md view that summarizes applicable files and opens existing `AgentsMdDialog` in correct context; invalidate/refetch after saves.
9. Integrate desktop in-flow rail and mobile Base UI sheet. Keep independent scrolling, protect transcript/composer widths, safe-area and virtual keyboard behavior.
10. Add accessible tab/list semantics, keyboard navigation, focus rings, collapse state announcements and reduced-motion/reduced-transparency behavior.
11. Test API/storage and UI state; verify no note leakage across sessions and accurate skills/files context.
12. Run `npm run check`, `npm test`, `npm run build`, `git diff --check`; manually test wide desktop, 1280px, 1024px, tablet, 390px mobile with keyboard open, long task/note, no tasks/run, skills unavailable, no AGENTS.md, all views, collapse/reopen, and two chats.

## Boundaries and security

- Do NOT alter task extraction/status/run, transcript, model selection, or composer sending.
- Do NOT store Notes in AGENTS.md, transcript, localStorage-only, or global settings.
- Do NOT inject Notes or Skills into model prompts automatically.
- Do NOT expose full Skills file contents; metadata only. Do not scan arbitrary filesystem paths or execute skill scripts/extensions.
- Do NOT duplicate AGENTS.md editing; reuse existing dialog and server protections.
- Do NOT silently discard unsaved notes on chat switch or revision conflict.
- Preserve all existing user edits; never checkout/reset/stash.
- No commits/deploy unless explicitly requested.

## Acceptance / verification

- Expanded chat always shows Tasks by default, including a useful no-task empty state.
- Tasks, Notes, Skills and AGENTS.md views all work and are scoped correctly.
- Hide/show is discoverable, accessible and persists independently per chat.
- Notes persist through reload/device, have conflict handling and bounded size, and are not prompt-injected.
- Skills view shows only real supported runtime metadata or an honest unavailable state.
- AGENTS.md view links into the existing editor with correct project/path.
- Desktop panel does not overlay/cripple transcript; mobile sheet does not cover composer/keyboard; independent scroll regions work.
- Keyboard-only, screen reader, dark/light, high contrast and reduced motion/transparency work.
- `npm run check`, `npm test`, `npm run build` pass.

## Emil / Apple rationale

- A frequent in-chat tool switch is high-frequency: instant state change, no entrance animation. Hide/show should be immediately responsive and clearly expose agency.
- Tasks are primary because user explicitly requested persistent visibility; advanced context tools sit beside them without competing with transcript.
- Proximity and specific labels make hierarchy/wayfinding legible. Avoid hiding important tools inside a generic overflow menu.
- Use clear status, adequate hit targets, keyboard and screen-reader semantics. Accessibility and mobile keyboard behavior are part of the interaction, not follow-up polish.
- Reduced motion/transparency are built into the surface. Any motion must have a named purpose, use existing tokens, and avoid layout animation.

Sources: `https://emilkowal.ski/skill`, `https://github.com/emilkowalski/skill` (skills `emil-design-eng`, `apple-design`, `animate`).
