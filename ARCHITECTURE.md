# Workbench final architecture

## Components and data flow

* React + Vite is the console. TanStack Query owns server snapshots; one SSE
  connection applies live updates and invalidates affected queries. Heavy panels
  and Markdown load on demand. Transcript virtualization uses individual messages.
* `worker.js` serves authenticated edge assets and forwards API requests to the
  gateway. `worker-alias.js` is a compatibility redirect, not a second application.
* `server.js` is the loopback gateway (8787): login rate limits, cookie validation,
  and streaming proxy to the loopback control service (8788). Shared auth helpers
  define the cookie protocol and internal-key comparison.
* `server/control.mjs` composes HTTP routes, runtime hooks and domain modules:
  SQLite store, scheduler, workspaces, messages, SSE, legacy import, usage and
  notifications. No distributed queue, directory lock, VM or overlay filesystem.
* SQLite WAL is the durable source of truth for conversations, commands, messages,
  artifacts, usage and bounded event replay. `synchronous=NORMAL` avoids an fsync
  per write (an OS/power failure can lose the most recent transactions). Blobs and
  native engine sessions live on disk. Legacy data is an optional read-only import.

## Run lifecycle and concurrency

1. Accept a stable client command ID in a transaction; store the user message and
   queued command. Duplicate delivery is idempotent.
2. Select the oldest runnable command, excluding paused or already-live
   conversations in SQL. Reserve its worker slot synchronously before preparing
   its workspace. Failure in one conversation does not block unrelated queues.
3. Each conversation has at most one live run. Different conversations may run in
   **any identical directory**, including home and General. There is no directory
   lease. `maxRuns` (1–8, default 2) bounds resident workers, including those waiting
   for input; waiting workers retain memory and their slot. Starting workers
   reserve estimated RAM before another worker is admitted. Use host/cgroup memory
   headroom and a periodic tick, so temporary memory pressure is retried.
4. Both engines use a sandboxed child process. Pi uses IPC; OpenCode uses a private,
   authenticated loopback server per active run. Discovery uses a separate bounded
   service. A run owns its process group through exit, including cancellation and
   timeout escalation. No slot is released merely because a child reports `done`.
5. States: queued → starting → running ↔ waiting_for_user/permission → completed,
   failed, cancelled or interrupted. Terminal failures pause only that conversation.
   Restart marks stale live commands interrupted_by_restart; explicit resume retries
   queued work. Cleanup and scheduler wakeup happen in `finally`.
6. Transient provider/network failures (`network_error`, `provider_unavailable`,
   `provider_rate_limit`) are **requeued with exponential backoff** instead of
   failing the run: the attempt counter and a not-before timestamp are durable,
   the scheduler honours the timestamp, and the conversation is not paused. Only
   terminal codes (auth, context, model, git conflict) end the run.

## Workspace model

* Git build runs in either engine use a worktree per conversation. Use the selected
  checkout as the root; preserve its tracked dirty baseline. Worktree errors fail
  visibly rather than silently writing the original checkout. Subsequent turns
  reuse the conversation's worktree. Apply is an explicit checked binary patch;
  conflicts preserve work. Discard removes only the owned worktree.
* Non-git runs use the requested directory in place. General uses `control/general`.
  Concurrent writers may conflict; this is intentional, with no directory lease.
* Plan mode exposes read-only workspace mounts. Git metadata mounts are explicit.
  Changing a conversation's workspace requires no live/queued run, resets native
  binding, and retires old worktrees against their original root. `project_id` and
  canonical `directory` are validated together.

## Persistence and streaming

* `text.delta` is live-only SSE, with **no durable event ID** and no SQLite write.
  Send an initial assistant snapshot so the browser can apply the first delta.
  Full messages checkpoint at a multi-second interval and at message/tool end;
  final snapshots replace accumulated text. Usage is idempotently upserted.
* Durable replay stores compact invalidations rather than copies of entire
  messages. Retention is bounded by age and count; sequence IDs never rewind after
  pruning. Initial/reconnected clients resnapshot active transcripts because live
  deltas cannot be replayed. Expired/future/oversized replay cursors receive resync.
* SSE buffers are bounded. Slow clients disconnect and resnapshot; they cannot
  grow server memory indefinitely. Images and tool artifacts are normalized on
  ingestion. Serializing an existing transcript does not write files or SQLite.

## Security boundary

* Edge cookies and internal proxy keys are distinct credentials. Incoming proxy
  headers are replaced at the authenticated edge. Internal key checks fail closed.
* Bubblewrap isolates agent execution by default: explicit read-only system/home/app
  mounts, isolated PID namespace and `/tmp`, private `/proc`/`/dev`, and writable
  workspace/native state mounts. There is one explicit, reversible escape hatch:
  `WORKBENCH_SANDBOX=off` (or `0`/`false`) runs agents directly on the host with
  full filesystem access and no secret masks, for operators who deliberately need
  it. It is never a silent fallback — the switch is set in the service environment.
  Name resolution is part of the sandbox contract: `/etc/resolv.conf` is commonly
  a symlink into `/run` (systemd-resolved), so the sandbox snapshots that file and
  read-only-overlays `/etc` with it. The `/run` directory itself is never mounted
  (its world-writable systemd-resolved sockets must not leak); without the overlay
  the symlink dangles, every run loses DNS, and all model/provider calls fail with
  a connection error.
* Mask `~/.config/secrets`, `~/.ssh`, `~/.aws`, `~/.netrc`, `~/.git-credentials`,
  `~/.config/gh`, `~/.local/share/opencode/mcp-auth.json`, `~/.docker`, `~/.kube`,
  `~/.npmrc`, `~/.pypirc`, control state and known host credential stores after
  workspace mounts, including when workspace is home. Shell/systemd user startup
  paths (`~/.bashrc`, `~/.profile`, `~/.zshrc`, `~/.config/systemd/user`,
  `~/.config/autostart`, `~/.config/environment.d`, `~/.local/bin`) are always
  masked so an agent that writes into a home workspace cannot gain persistence
  outside the sandbox. Agent subprocess environments use an allowlist; control,
  Cloudflare, SMTP and session secrets never pass through to shell tools.
* Network remains available for models and development. Provider credentials and
  native session state needed by an engine are trusted runtime inputs, not control
  API credentials. This is filesystem/process isolation, not a network DLP service
  or an absolute resource quota for arbitrary build commands. Admission headroom,
  bounded processes/output, deadlines and host service limits prevent routine
  overload; operators must size host limits for untrusted memory-intensive builds.
* Canonical-path write guards catch accidental traversal/symlink escapes. Permission
  prompts are UX controls; shell regexes are not the security boundary.

## Operations and verification

Health exposes queue depth, resident workers, admission reason/memory, event counts,
SSE clients and process memory. Structured failures include run/conversation IDs;
optional maintenance failures are logged without crashing the scheduler. Polling
is a slow visible-tab fallback; system/process polling runs only for open panels.
The control service cgroup also contains every sandboxed agent child, so its
memory ceiling/high-water mark must fit the whole fleet; the scheduler admits runs
from real free memory (a ceiling, not a reservation). Periodic maintenance prunes
events/artifacts, checkpoints the WAL, and removes applied/discarded worktrees
past their retention window.
Tests cover same-folder concurrency, fairness, waiting/cancellation/restart,
retention/resync, worktree conflicts, environment/path guards and sandbox denial.
`npm run check` and `npm test` are required; builds used for inspection must not
promote assets or restart the running services.
