# PLAN: Pi-first refactor self-hosted AI coding dashboardu

**Dátum:** 6. október 2026
**Repozitár:** `~/projects/Workbench`
**Zadanie:** kompletne prerobiť existujúci dashboard na Pi-first produkt: chat-first,
rýchly, spoľahlivý, resumovateľný, observovateľný, s paralelnými behmi a bez
terminálovej orchestrace. Tento dokument je štruktúrovaná transkripcia zadania
(46 bodov) + audit súčasného stavu + fázy + rozdelenie práce pre 4 agentov.

---

## 0. Zásady

Priorita nie je počet funkcií, ale: **fast, simple, reliable, resumable,
observable, efficient, intuitive**. Žiadne microservices/K8s/distributed
abstractions (§44). Rozhodnutia robia inžinieri; otázky len pri nebezpečnej
nejasnosti (§43).

Cieľová architektúra v jednom diagrame (§47):

```
Dashboard / Chat UI
      ↓
Durable control plane + state (SQLite)
      ↓
Pi agent harness  (univerzálny)
      ↓
selected provider/model  (replaceable)
      ↓
structured tools
      ↓
project / isolated Git workspace
```

- **Chat** = trvalá konverzácia (bez živého procesu).
- **Run** = jedna aktivácia Pi (durable záznam).
- **Worker** = dočasný proces vykonávajúci Run (disposable).
- **Workspace** = filesystem/Git stav.
- **Provider/model** = vymeniť ​ľná inteligencia.
- **Pi** = jediný agent harness.

## 1. Rozhodnutia tohto kola (implementovať teraz)

1. **Pi je primárny a univerzálny harness.** Nové chaty štandardne `engine='pi'`.
   OpenCode runtime zostáva len ako „advanced/debug" adapter a NIE je na
   kritickej ceste (dočasná kompatibilita, neskôr odstrániť — §42).
2. **Žiadne CLI/TUI/terminal scraping.** Pi sa používa programaticky cez SDK
   (`createAgentSession`, `SessionManager`, `defineTool`, extension API,
   tool factories) v `server/pi-runner.mjs`; terminál ostáva len ako
   voliteľný „Advanced terminal" mimo stavu chatu.
3. **Worker = per-Run child proces, ktorý po Run zanikne.** Chat/transcript
   žije v control plane (SQLite + Pi `SessionManager` súbory), nie v procese.
4. **Control plane je jediný zdroj pravdy** pre Chat, Runs, eventy, usage,
   approvals, TODOs, worktrees.
5. **Paralelné Runy** s konfigurovateľným limitom (`WORKBENCH_MAX_RUNS`,
   default 1 → používateľ si zvýši), fronta viditeľná.
6. **Git worktree izolácia** pre mutujúce Runy v projektoch; read-only Runy
   bežia bez worktree (§13).
7. **Štruktúrované eventy** namiesto terminálu: text.delta, tool.* (typed),
   todo.updated, question.required, permission.required, usage.updated,
   run.state, file.changed, git.diff.updated, test.completed, run.completed.
8. **Model/provider je viditeľný a prepínateľný**; zmena počas chatu vytvorí
   trvalý systémový event a budúce Runy použijú nový model; staré správy si
   držia model, ktorý ich vytvoril.
9. **Notifikácie**: in-app „attention" stavy + SSE; browser notifications
   voliteľne; SMTP je odložené (len preferencia a async hook, nesmie blokovať Run).
10. **AGENTS.md**: globálny + projektový, detekcia nested, read/edit v UI,
    Pi dostane applicable inštrukcie do kontextu (`loadProjectContextFiles`).
11. **Usage pacing**: manuálne limity/rozpočty + provider-reported kde existuje;
    jasne rozlíšiť reported/estimated/manual; žiadne vymyslené provider limity.
12. **Odstrániť mŕtvy kód** starej architektúry po migrácii (Herdr už je preč;
    OpenCode endpoints skryť z bežného UI).

## 2. Audit súčasného stavu

| Oblasť | Stav | Verdikt |
|---|---|---|
| Gateway `server.js` | auth + `/api/v2` proxy + statika | **KEEP** |
| Control `server/control.mjs` | SQLite, commands(=runs), SSE, scheduler (jeden globálny run), usage, clips, projekty | **REFACTOR** (Pi default, run lifecycle, worktrees, notifikácie, usage limity) |
| Store `server/store.mjs` | conversations/commands/messages/events/usage/clips/attachments/interactions/artifacts/FTS | **REFACTOR** (migrácie: worktree, todos, attention, run metadata) |
| OpenCode runtime | headless `opencode serve`, eventy + polling | **KEEP ako advanced/debug**, mimo default cesty |
| Pi runtime `server/runtimes.mjs` + `server/pi-runner.mjs` | SDK (`createAgentSession`, `SessionManager`, `session.subscribe`, `waitForIdle`) | **REFACTOR na hlavný harness** (typed events, tools, questions/permissions, todo) |
| UI Whirl (`App.tsx`, `chat-view`, `sidebar`, `thread/*`, `composer`, `model-menu`, `usage-view`, `system-panel`, …) | obnovené pôvodné UI na v2 | **KEEP + EXTEND** |
| `/assistant` + Ask panel | read-only chat | **KEEP** (sekundárne) |
| Herdr/TUI | odstránené | **DONE** |
| Notifications | len toasty | **REPLACE** (attention centrum + browser) |
| Usage | ledger + dashboard | **EXTEND** (limity, pacing, provider usage) |
| Worktrees | žiadne | **ADD** |
| TODO/ETA/attention | žiadne | **ADD** |
| File references/viewer | žiadne | **ADD** |
| Conversation nav strip | žiadne | **ADD** |
| AGENTS.md | žiadne | **ADD** |

Pi SDK 0.87.1 poskytuje: `createAgentSession`, `AgentSession`, `SessionManager`,
`ModelRuntime`, `DefaultResourceLoader`, tool factories (`createReadTool`,
`createEditTool`, `createBashTool`, `createGrepTool`, `createFindTool`,
`createLsTool`, `createCodingTools`, `createReadOnlyTools`), `defineTool`,
extension API (`ExtensionRunner`, `discoverAndLoadExtensions`),
`loadProjectContextFiles`, `renderDiff`, `generateUnifiedPatch`,
`serializeConversation`, `calculateContextTokens`, `getLastAssistantUsage`.
Presné kontrakty pre tools/permissions/questions musí overiť Agent A spikeom.

## 3. Dátový model (rozšírenia)

Existujúce tabuľky sa migrujú (nie rušia). Pribudne:

- `runs` (alebo rozšírené `commands`): stav podľa §9 (queued, starting,
  running, waiting_for_user, waiting_for_permission, interrupting, interrupted,
  completed, failed, cancelled, interrupted_by_restart), `engine`, `model`,
  `provider`, `worktree`, `todos` (JSON), `attention`, `heartbeat`, `eta_low/high`,
  `usage` summary, `started/ended`.
- `run_events`: typed events pre UI (kind + payload + seq) — buď nová tabuľka,
  alebo rozšírenie `events` o `kind`/`run_id`.
- `workspaces`: `id, project_id, run_id, path, branch, base_branch, base_commit,
  status(applied|discarded|conflict|active)`.
- `questions` / `approvals`: už `interactions`; rozšíriť o `options`,
  `answers`, `run_id`, `status`.
- `agent_instructions`: `scope(global|project), project_id, path, content,
  revision, active`.
- `usage_limits`: `scope(provider|global), period(weekly|monthly), limit_tokens,
  limit_cost, reset_at, manual`.
- `notifications`: `id, kind, severity, conversation_id, run_id, title, body,
  read, created, delivered`.
- `settings`: existuje key/value — použiť pre preferencie notifikácií a defaulty.

Zachovať jednoduchosť: preferovať rozšírenie existujúcich tabuliek pred
novými vrstvami.

## 4. Eventy a SSE (kontrakt pre frontend)

Jeden multiplexovaný `/api/v2/events` (SSE) s `seq`, `type`, `conversationId`,
`runId`. Typy (najdôležitejšie):

```
run.state            { status, previous, model, provider, started, ended, error }
text.delta           { messageId, delta }
message.updated      { message }
tool.started         { toolCallId, kind, title, input? }
tool.completed       { toolCallId, kind, status, summary, artifactId? }
file.changed         { path, change: created|modified|deleted, additions, deletions }
file.read            { path }
command.started/completed { command, exitCode?, summary }
test.completed       { passed, failed, summary }
todo.updated         { todos: [{ id, text, status }] }
question.required    { interactionId, questions }
permission.required  { interactionId, action, detail }
git.diff.updated     { worktreeId, files: [{ path, additions, deletions }] }
usage.updated        { runId, input, output, cacheRead, cacheWrite, cost }
run.completed        { status, filesChanged, tests }
attention.changed    { conversationId, attention: none|waiting|permission }
notification.created { id, kind, conversationId, title }
```

Frontend aktualizuje cielené cache; žiadne plošné invalidácie pri každom evente.

## 5. Fázy

**Fáza 1 (toto kolo) — Pi-first core + paralelizmus + štruktúrované eventy.**
Pi default, run lifecycle + recovery, konfigurovateľná konkurencia, worktree
izolácia + diff/apply/discard, typed event pipeline, run summary (status, TODO,
current action, elapsed, ETA, Stop), running/attention sidebar, model switch
eventy, file references + viewer, conversation nav strip, usage limity/pacing,
in-app notifikácie + browser notifications, AGENTS.md read/edit + Pi kontext.

**Fáza 2 (ďalšie kolo) — otázky/permissiony cez Pi custom tools, SMTP async,
provider-reported usage integrácie, codex/claude adaptéry (voliteľné), hlbšie
ETA, debloat a odstránenie OpenCode z bežnej cesty.**

## 6. Rozdelenie práce pre 4 agentov (vlastníctvo súborov)

Pravidlá pre všetkých: nespúšťať `npm run build/deploy`, `wrangler`, ani
`systemctl restart` (produkcia beží!). Žiadne nové závislosti bez potreby.
Editovať len vlastné súbory. Držať sa existujúcich Whirl štýlov. Report na konci.

### Agent A — Pi harness a runtime
Súbory: `server/pi-runner.mjs`, `server/runtimes.mjs`, nové `server/pi/*.mjs`.
- Spike SDK (defineTool, extension API, tool factories, SessionManager, events,
  loadProjectContextFiles) a zapíš zistenia do `server/pi/CAPABILITIES.md`.
- Pi je primárny: `PiRuntime` ako default, worker per Run, disposable.
- Normalizuj Pi eventy na typed eventy z §4 a posielaj ich cez IPC controlu.
- Definuj malý, koherentný štruktúrovaný tool layer (read/search/list/edit/write/
  bash/git diff/tests/todo/ask_user/permission) cez Pi tool factories/defineTool.
- Model/provider per Run cez `ModelRuntime`; reportuj usage (`getLastAssistantUsage`).
- `ask_user` a `permission` request cez Pi mechanizmus, ak to SDK umožní; inak
  priprav hook a zapíš obmedzenie.
- NEEDITUJ `server/control.mjs`.

### Agent B — Control plane, run lifecycle, worktrees, usage limity, AGENTS.md
Súbory: `server/control.mjs`, `server/store.mjs`, nové `server/workspaces.mjs`,
`server/usage-limits.mjs`, `server/notifications.mjs`.
- Pi default engine; OpenCode len advanced.
- Run lifecycle podľa §9 + heartbeat + reconciliation pri štarte (§16) + zákaz
  duplicitných workerov; konfigurovateľný concurrency limit + fronta.
- Git worktree izolácia pre mutujúce Runy (§12), `apply`/`discard`, konflikty
  surfacovať; read-only bez worktree (§13).
- Endpointy: project file read, AGENTS.md (global/project, nested detect,
  read/write), usage limits + pacing, notifications.
- Rozšír `events`, migration `user_version`.
- NEEDITUJ `server/pi-runner.mjs`, `server/runtimes.mjs`, ani frontend.

### Agent C — Chat/run UX
Súbory: `src/components/whirl/chat-view.tsx`, `thread/*`,
`src/components/whirl/run-summary.tsx` (nové), `conversation-nav.tsx` (nové),
`file-viewer.tsx` (nové), `interaction-card.tsx`, `composer.tsx`,
`model-menu.tsx`.
- Run summary card: Working, x/y tasks, current action, elapsed, ETA, Stop (§28).
- Renderovanie toolov podľa typu (file changed, command card, test card, git diff)
  namiesto raw payloadov (§23).
- Interaktívne otázky a permission UI (§24/25) napojené na existujúce
  `/interactions/:id`.
- File viewer: kód s highlightom a číslami riadkov, obrázky, download; rozlíšiť
  read/changed/created/deleted (§21).
- Conversation navigation strip pre user prompty (§20).
- Model switch systémový event (§6).
- Props a event kontrakt drž presne podľa §4/§6; socket/SSE napája Agent D v App.
- NEEDITUJ `App.tsx`, `sidebar.tsx`, `pages/usage-view.tsx`.

### Agent D — Shell, running/attention, usage, notifikácie
Súbory: `src/App.tsx`, `src/components/whirl/sidebar.tsx`,
`src/components/whirl/system-panel.tsx`, `pages/usage-view.tsx`,
`pages/notifications-center.tsx` (nové), `search-palette.tsx`, `src/lib/*`.
- Sidebar: sekcie/filter Running a Needs attention (§17), archive/unarchive/delete,
  running-only filter, search (§18).
- Top-left provider/model + kompaktný usage status (§30).
- Usage view: limity, pacing, budgety, reported/estimated/manual (§30–32).
- In-app attention centrum + browser notifications + preferencie (§33).
- SSE typed eventy → cielené cache aktualizácie; minimalizovať rerenders (§34/35).
- Napojiť komponenty Agentov C cez zamrznuté props.
- NEEDITUJ `chat-view.tsx`, `thread/*`, `run-summary.tsx`, `conversation-nav.tsx`,
  `file-viewer.tsx`, `interaction-card.tsx`, `composer.tsx`, `model-menu.tsx`.

### Zamrznuté props (medzi C a D)
- `RunSummary({ session, run, onStop, onInterrupt })` — renderuje sa v chat-view.
- `ConversationNav({ messages, viewportRef, onJump })` — v chat-view.
- `FileViewer({ open, file, onOpenChange, onToast })`, kde
  `file = { path, status: 'read'|'changed'|'created'|'deleted', projectId }`.
- `InteractionCard({ interaction, onDone, onError })` — existujúce, C rozšíri o
  options/answers/permission.
- SSE event typy presne podľa §4.
- Sidebar dostane `running: Session[]`, `attention: Session[]`.

## 7. Acceptance (testovať v tomto kole)

Skrátený §46, čo musí prejsť end-to-end na VPS:

1. Nový chat → otázka cez Pi → read/search tool → streamovaná odpoveď.
2. Nadväzujúca coding požiadavka → mutujúci Run vo worktree → typed tool eventy →
   TODO/current action → edit → shell/test → file preview → diff.
3. Druhý chat paralelne → Running sidebar ukazuje oba.
4. Zavrieť browser → Run pokračuje; po návrate sa stav zrekonštruuje.
5. ESC interrupt → Run sa zastaví, nič sa nestratí; pokračovanie ďalšou správou.
6. Reštart control → staleness reconciliation (žiadne „running" navždy).
7. Otázka (question) a permission → UI odpovie → ten istý Run pokračuje.
8. Apply/Merge alebo Discard zmien z worktree; konflikt sa zobrazí.
9. Archive → restore → delete chat.
10. Usage pacing a notifikácia pri dokončení/attention.

Poradie integrácie: A (harness) + B (control) musia byť hotové pred C/D
napojením; D vlastní App a napojí C komponenty. Orchestrátor po agentoch spraví
typecheck, build, smoke/workflow testy a manuálny E2E, doplní chýbajúce a nasadí.

---

## 8. FÁZA 2 — dorobenie medzier zo zadania (aktuálne kolo)

Fáza 1 je hotová a nasadená: Pi-first control plane, run lifecycle
(`queued|starting|running|waiting_for_user|waiting_for_permission|interrupting|
interrupted|completed|failed|cancelled|interrupted_by_restart`), typed SSE
eventy, worktree endpointy + apply/discard, usage limity/pacing, notifikácie,
RunSummary, file viewer, conversation nav, running/attention sidebar, model
switch eventy, AGENTS.md endpointy. Overené: oba engine-y (smoke), Pi default
E2E, paused→send auto-resume.

### Čo v Fáze 2 doplniť (presne podľa §)

| § | Chýba | Workstream |
|---|---|---|
| §12, §46 | Apply / Discard / View changes **UI** (endpointy `/runs/:id/{changes,apply,discard}` a `/worktrees` existujú) | Agent E |
| §29 | AGENTS.md **UI** (view/edit global+project, nested scope) — endpointy `/agents-md` existujú | Agent E |
| §15 | **ESC** interrupt aktívneho Runu (rešpektovať modály/paletu/file viewer) | Agent E |
| §11 | **paralelnosť**: default MAX_RUNS aspoň 2 + nastavenie v UI + zobrazenie fronty | Agent F |
| §19 | **live `text.delta`** (teraz len snapshoty `message.updated`) | Agent H |
| §33 | **SMTP async** (neblokujúce, disabled default, preferencie) | Agent F |
| §40 | **špecifické chyby** (rate limit, auth, context limit, worker crash, git conflict…), nie „Something went wrong" | Agent F |
| §29 | AGENTS.md doručenie Pi do kontextu cez `loadProjectContextFiles` (nie prepend promptu) | Agent H |
| §23 | štruktúrované tool party musia prežiť do UI (dnes `safePart` stripuje do artifactu → fallback karty) | Agent H |
| §27/§28 | `currentAction`, `eta`, `todos` v `activeRun` | Agent H (dáta) + E (render) |
| §46 | **acceptance testy**: worktree apply/discard, restart recovery, question/permission round-trip, parallel runs, notifications, pacing | Agent G |

### Fáza 2 agenti (vlastníctvo)

- **Agent E (frontend gaps)** — `src/components/whirl/run-summary.tsx`,
  nové `changes-panel.tsx`, `agents-md-dialog.tsx`, `src/components/whirl/chat-view.tsx`
  (ESC), `src/components/whirl/session-menu.tsx` (entry pre AGENTS.md/settings),
  `src/App.tsx` (napojenie, concurrency nastavenie). Vizuál Whirl, žiadny nový dizajn.
- **Agent F (control plane)** — `server/control.mjs`, `server/usage-limits.mjs`,
  nový `server/smtp.mjs`. Default `maxRuns=2` + `settings.maxRuns`, SMTP async,
  §40 chyby. NEEDITUJ `runtimes.mjs`/`pi-runner.mjs` ani frontend.
- **Agent G (testy/acceptance)** — `scripts/workbench.*.mjs`, nový
  `scripts/workbench.acceptance.mjs`. Len testy + report; bugy v serveri hlásiť.
- **Agent H (Pi harness polish)** — `server/runtimes.mjs`, `server/pi-runner.mjs`,
  `server/pi/**`. text.delta, AGENTS.md do kontextu, štruktúrované party,
  currentAction/eta/todos, deleted-file detekcia, question/permission hardening.
  NEEDITUJ `control.mjs` (Agent F) — kontrakt hookov ostáva z Fázy 1.

Kontrakty z Fázy 1 (§4 eventy, hooky, zamrznuté props) ostávajú platné.
