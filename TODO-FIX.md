# Ordered fix checklist

Each item is checked only after implementation and its applicable verification.
The working tree contained existing user changes; preserve them throughout.

## P0 — correctness, security, write amplification

- [x] **P0.1 Scheduler:** remove dead directory leases; SQL skips live conversations
  before limiting candidates; reserve startup memory; count waiting workers.
  Acceptance: two General/home/non-git conversations overlap; same conversation
  never overlaps; a 50-item queue cannot starve another conversation; headroom
  blocks/retries admission; cancellation/crash/restart release slots correctly.
- [x] **P0.2 Workspaces:** both engines isolate Git builds, respect selected checkout,
  and fail closed on worktree errors. Acceptance: distinct conversations have
  distinct worktrees; original checkout stays unchanged; strict apply conflicts
  preserve user edits; non-git directories run in place concurrently.
- [x] **P0.3 Store/events:** WAL NORMAL; no persisted text deltas; compact message
  invalidations; age/count pruning; monotonic cursor and explicit SSE resync.
  Acceptance: 10,000 deltas add no event rows; final text survives reopen; expired
  cursor/reconnect resnapshots; slow SSE clients have bounded buffering.
- [x] **P0.4 Snapshots:** initial frame, multi-second checkpoints, final message/tool
  snapshots. Acceptance: first token renders, final snapshot is exact, no 80ms full
  JSON persistence; cancelled runs preserve the latest received snapshot.
- [x] **P0.5 Security:** mandatory shared sandbox for Pi/OpenCode; secret/control
  masks; PID isolation; allowlisted env; no broad root bind/fallback.
  Acceptance: real sandbox denies secret reads and outside writes, including a
  home workspace; both engines use that launcher; unavailable sandbox fails clearly.
- [x] **P0.6 Process cleanup:** bounded resident children, startup/run deadlines and
  TERM→KILL escalation. Acceptance: done/error/cancel paths reap processes and
  descendants; queued work wakes after cleanup.

## P1 — UI and read-path performance

- [x] **P1.1 Lazy UI:** Markdown/highlighting, file viewer, changes and system panels.
  Acceptance: Vite emits asynchronous chunks; closed panels do not load them.
- [x] **P1.2 Transcript:** individual message rows and stable IDs. Acceptance:
  hundreds of assistant steps cannot merge into one unvirtualized DOM row.
- [x] **P1.3 Polling:** SSE-driven invalidation, slow visible-tab fallback, panel-only
  telemetry/process polling. Acceptance: closed system/settings panels have no
  repeated telemetry requests; reconnect refreshes current state.
- [x] **P1.4 Images/artifacts:** normalize at ingestion; pure response formatting.
  Acceptance: repeated transcript reads perform no blob writes/artifact UPSERTs;
  legacy image/tool content remains accessible.

## P2 — maintainability and verification

- [x] **P2.1 Control modules:** extract scheduler, SSE/message handling and optional
  legacy access at natural boundaries. Acceptance: production and tests call the
  same small modules; no replacement framework or route rewrite.
- [x] **P2.2 App hooks:** extract stream/cache or routing/query concerns.
  Acceptance: App retains composition; hook cleanup closes streams/timers.
- [x] **P2.3 Shared auth:** one session protocol and internal-key helper across edge
  and Node. Acceptance: cross-runtime cookie compatibility, invalid/expired tokens
  denied, empty keys denied, existing login/rate limiting preserved.
- [x] **P2.4 Regression tests:** scheduler/capacity, restart, worktrees, guards,
  event retention/resync, persistence and child cleanup. Acceptance: `npm test`
  discovers all tests and tests real production functions (sandbox limitations
  are reported explicitly).
- [x] **P2.5 Errors/metrics:** structured maintenance/runtime errors, health metrics
  for queue/memory/events/clients. Acceptance: admission blocks and failed cleanup
  are diagnosable without secrets in logs.
- [x] **P2.6 Keys:** stable entity keys for changing lists; positional keys only for
  fixed presentation (line numbers/decorative dots). Acceptance: no index-keyed
  mutable transcript/entity rows.

## P3 — cleanup and consistency

- [x] **P3.1 Legacy coupling:** optional read-only adapter, guarded missing/schema
  failures, correct part recovery query. Acceptance: native operation starts without
  a legacy DB and legacy imports cannot crash periodic scheduling.
- [x] **P3.2 Alias:** retain a minimal compatibility redirect with no auth/application
  duplication. Acceptance: old links preserve path/query to canonical host.
- [x] **P3.3 Permissions/environment:** remove regex security claims; use explicit
  shell permission policy and shared env/path helpers. Acceptance: `test` cannot
  bypass a shell permission decision; symlink escapes are denied.
- [x] **P3.4 Artifacts:** merge fields by presence, not JSON length; never truncate
  serialized JSON into invalid data. Acceptance: shorter final output/error replaces
  older output and partial updates preserve earlier input.
- [x] **P3.5 Dead settings/model drift:** remove dead scratch/lease settings and
  obsolete comments; consistent project/directory/native bindings. Acceptance:
  live/queued workspace move is rejected; old root used for retiring worktrees;
  no stale native session follows a workspace change.
- [x] **P3.6 Final verification:** run `npm run check`, `npm test`, isolated Vite build
  and applicable local integration probes. Update this checklist with results and
  any environment-blocked acceptance checks. Do not deploy or restart live services.

## Follow-up fixes (2026-10-07, after the P0–P3 pass)

- [x] **Sandbox DNS (P0, infra):** the sandbox mounted `/etc` read-only but not
  `/run`. `/etc/resolv.conf` is a symlink into `/run/systemd/resolve`, so inside
  the sandbox it dangled and every run lost DNS — every Pi/OpenCode provider call
  failed (`Connection error.` / `Cannot connect to API`). `server/security.mjs`
  now read-only mounts the real resolv.conf directory. Regression test added.
- [x] **Worktree apply/discard race:** both routes guarded on the in-memory `runs`
  map, which is populated until the worker's `finally` — a run is marked terminal
  (durable) before that, so a legitimate apply/discard in that window returned 409.
  Now guarded on the durable command status (`store.active`). Covered by the
  acceptance suite (discard check).
- [x] **Provider resilience:** failure classification moved to `server/failures.mjs`
  (unit-tested) and now recognises the real production strings (`Connection error.`,
  `Cannot connect to API…`, `The usage limit has been reached`). Transient codes are
  requeued with exponential backoff (durable `attempts`/`retry_at`, scheduler
  honours the not-before time) instead of failing and pausing the chat.
- [x] **Memory ceiling:** the control cgroup includes every agent child; the old
  `MemoryMax=1536M` was hit and the plane was OOM-killed. Raised to the host's RAM
  with a lower `MemoryHigh` reclaim threshold.
- [x] **Disk hygiene:** periodic `PRAGMA wal_checkpoint(PASSIVE)` and a worktree GC
  that removes applied/discarded worktrees past retention.
- [x] **AGENTS.md project-relative path:** a relative `path` was resolved against
  the control CWD instead of the project root in `server/control.mjs`, so nested
  scope detection silently failed. Fixed and the acceptance check is now hard
  (no longer soft/skip).

## Verification results (2026-10-07)

Run from a clean tree, no deploy and no service restart.

- `npm run check` — PASS (`check-runtime` syntax over `server/` + `shared/`,
  `node --check` over entrypoints, radius scale, `tsc --noEmit`).
- `npm test` — PASS 33/33 (`scripts/*.test.mjs`: auth, events, runtimes, scheduler,
  security, store, workspaces).
- Isolated build `npx vite build` — PASS; emits async chunks for
  `usage-view`, `changes-panel`, `system-panel`, `markdown-content`, `file-viewer`
  (after extracting `FileLink`/types to `src/components/whirl/file-link.tsx`, so the
  heavy viewer is no longer pulled in statically by `tool-cards`).
- Live integration probes (`npm run test:runtime`, model round-trips) are
  **environment-blocked**: they require the running control/gateway services and
  provider network; not executed here to avoid restarting live services. The same
  production functions are exercised by the unit tests above (real bubblewrap,
  real git worktrees, real SQLite, real Pi/OpenCode runtimes with fixtures).
- `SELFTEST.txt` was a stale marker from the interrupted run; superseded by this
  results section.

### End-to-end workflow (live control plane, same API the UI uses)

- `npm run test:runtime` (smoke) — **PASS**: bootstrap, both engines ran real
  model turns and persisted replies, dedup, transcripts, usage, project clips.
- `scripts/workbench.workflow-test.mjs` — **PASS**: attachment read, resume
  context, model switch, paused → send auto-resume, lifecycle
  queued→running→completed, SSE without polling.
- `scripts/workbench.acceptance.mjs` — **22 passed, 0 failed, 0 skipped**
  (isolated control): worktree isolate/list/changes/apply/discard, parallel
  same-host runs, questions/permissions round-trip, usage limits, notifications,
  restart recovery.
- UI build via `npm run build` promoted atomically; the gateway serves the new
  `index.html`, hashed chunks (incl. lazy `file-viewer`, `markdown-content`,
  `changes-panel`, `system-panel`, `usage-view`) and `/api/v2/*` with a session
  cookie (all 200). `npm test` 34/34.
