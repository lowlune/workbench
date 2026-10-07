# Workbench — finálny plán (jediný zdroj pravdy)

**Dátum:** 2026-10-07
**Stav:** aktuálny a záväzný. Nahrádza všetky staršie plány, ktoré sú v `docs/archive/`.

## Ako čítať dokumentáciu
- **`PLAN.md`** (tento súbor) — jediný plán: čo je hotové, čo zostáva, čo treba rozhodnúť.
- **`ARCHITECTURE.md`** — čo reálne existuje a ako to funguje (bez histórie).
- **`TODO-FIX.md`** — fix checklist z auditu (P0–P3). **Hotový**; ponechaný ako záznam.
- **`docs/archive/`** — staré snapshoty plánov (5 rôznych behov). Nič sa z nich neoživuje.

## 1. Čo Workbench je
Self‑hostovaný konzolový nástroj na riadenie kódovacích agentov: chat‑first UI, trvanlivý
control plane, izolované Git worktree, sandboxované behy (Pi + OpenCode engine), SSE
stream, usage/limity, notifikácie. Beží ako systemd user služby na VPS za Cloudflare
tunnelom.

## 2. Architektúra v skratke
- **Console** (`server.js`, :8787) — auth, rate‑limit, statické UI, proxy na control.
- **Control plane** (`server/control.mjs`, :8788) — SQLite store, scheduler, run
  lifecycle, worktree, SSE, usage, notifikácie, legacy import.
- **Runtimy** — Pi (IPC) a OpenCode (privátny loopback server), oba cez bubblewrap
  sandbox; jeden worktree na konverzáciu v Git projekte.
- **Edge** (`worker.js` + alias) — Cloudflare; lokálne servíruje gateway.
- **Dáta** — `~/.local/share/workbench` (SQLite + blobs + worktrees), záloha cez timer.

## 3. Stav k 2026-10-07 (overené, nie tvrdené)
- `npm run check` — PASS
- `npm test` — **48/48 PASS**
- `scripts/workbench.acceptance.mjs` (izolovaný control) — **22/22 PASS, 0 skip**
- `scripts/workbench.smoke.mjs` (live) — PASS (oba enginy reálne odpovedali)
- `scripts/workbench.workflow-test.mjs` (live) — PASS (prílohy, model switch, pause/resume, SSE)
- `npm run build` — PASS, UI sa servíruje (index + lazy chunky + `/api/v2/*` = 200)
- Služby: `workbench-console`, `workbench-control`, `workbench-cloudflare-tunnel` — active

## 4. Hotové
- Trvanlivý control plane: run lifecycle, recovery po reštarte, graceful drain, failure kódy.
- Scheduler: memory admission, žiadne directory lease, fair queue, retry_at.
- Worktree izolácia: create/changes/apply/discard, strict apply, GC po retencii.
- Store/eventy: WAL NORMAL, live‑only delty, kompaktná replay, pruning, monotonic cursor,
  WAL checkpoint.
- Snapshoty a SSE: initial frame, checkpointy, finálny snapshot, bounded buffers, resync.
- Sandbox: bubblewrap povinný, maskovanie secretov, allowlist env, **DNS fix** (resolv.conf).
- Procesy: bounded children, deadlines, TERM→KILL, úklid v `finally`.
- Provider resilience: klasifikácia chýb + **auto‑retry s backoffom** pre prechodné chyby.
- UI: lazy panely/markdown/file‑viewer, virtualizovaný transcript, SSE‑driven invalidácia,
  panel‑only polling.
- Shared auth (edge + Node), alias redirect, AGENTS.md, usage limity, notifikácie.
- Pamäť: control cgroup `MemoryMax` zdvihnutý na RAM hosta + `MemoryHigh` reclaim.
- Testy: unit + acceptance + smoke + workflow.
- **Hardening (orchestrované 4‑doménové audity + opravy):** opravený P0 UI crash
  (RunSummary hooks po early‑return), uncaught ReadStream → crash control plane,
  transient‑failure trvalé vypnutie OpenCode runtimeu, apply/discard race s queued
  behom, symlink escape v AGENTS.md, SMTP CRLF injection, sandbox únik cez
  `/run/systemd/resolve` a nemaskované credential stores, zápis do `~/.bashrc`/systemd
  pri home workspaci, git tool s ľubovoľnými `--output`, cgroup‑aware scheduler,
  `OOMPolicy=continue`, atómový+úplný backup, healthcheck timer, SIGTERM timeout.

## 5. Otvorené úlohy (prioritne)
### P0
1. **Commit** celej práce (audit + fixy) do gitu — teraz je všetko necommitnuté.
2. **Rozhodnúť hosting** (viď §6): ostať na worker + VPC tunnel, alebo single‑origin na
   VPS + named tunnel. Podľa rozhodnutia dotiahnuť `PLAN-HOSTING` variant (v archíve).

### P1
3. **Browser E2E** (Playwright) na kľúčové flows — teraz je UI overené len buildom a
   servírovaním, nie reálnym renderom.
4. **Load/scale test** scheduleru a pamäte (koľko reálnych agentov naraz host unesie).
5. **Edge worker E2E** proti staging (dnes len unit test `auth.test.mjs`).
6. **HA/SPOF**: jeden control proces; zvážiť auto‑resume po páde (recovery už označuje
   `interrupted_by_restart`).

### P2
7. **Vertical taby**: plán žiadal vertikálny pruh; reálne je horizontálny (`horizontal-tabs.tsx`).
   Rozhodnúť, či prepracovať alebo oficiálne nechať horizontálne.
8. **Host RAM**: 3814 MB + swap je tesný; pri ťažkých behoch zvážiť viac RAM.
9. **Disk retencia**: doladiť politiky (events/artifacts/worktrees) podľa reálnej prevádzky.

## 6. Rozhodnutia, ktoré potrebujem od teba
- **Commit?** (a správa commitu).
- **Hosting**: A) worker + VPC tunnel (súčasný) alebo B) single‑origin VPS + named tunnel.
- **Taby**: vertikálny pruh podľa pôvodného zámeru, alebo nechať horizontálne.

## 7. Neoverené / známe riziká (nezaručujem „0 bugov")
- Reálny browser render a všetky interakcie (netestované v prehliadači).
- Správanie pod skutočnou súbežnosťou a dlhými behmi (bez load testu).
- Edge worker v produkcii (len unit test).
- Externé prostredie a kvóty providerov (mimo kontroly Workbenchu).
- Single point of failure control plane.

## 8. Ako overiť
```bash
npm run check
npm test
npm run test:runtime                 # smoke proti live controlu
node scripts/workbench.workflow-test.mjs
node scripts/workbench.acceptance.mjs  # izolovaný control
npm run build
```
