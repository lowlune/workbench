# PLAN: Návrat pôvodného UI (Whirl console) na nový backend

**Dátum:** 6. október 2026
**Repozitár:** `~/projects/Workbench`
**Zadanie od používateľa (verbatim):**

> vráť všetky zmeny čo si urobil ohladom UI. UI bolo predtým lepšie aj layout
> aj obsah aj ten performance panel atď. jediné čo je teraz lepšie je usage.
> technicky to nechaj ale vráť UI nech je ako predtýmito zmenami.

---

## 1. Rozhodnutie

Obnoviť **pôvodné Whirl konzolové UI** (stav z 5. 10. 2026 — to, ktoré používateľ
reálne videl v produkcii: sidebar, home s chipmi, chat, history, clips, search
palette, session menu, **performance/system panel**, rename dialog, Ask panel)
a napojiť ho na **nový v2 control plane**. Zvyšok technickej práce (headless
OpenCode/Pi runtimes, SQLite, command queue, SSE, usage ledger, scheduler,
opravy SSE/gateway/systemd) zostáva bez zmien.

### Čo sa zachováva z novej práce
- `src/components/whirl/pages/usage-view.tsx` (nový Usage & models — používateľ ho chce)
- `src/components/whirl/model-picker.tsx` (používa ho usage-view pre defaulty)
- `src/components/whirl/interaction-card.tsx` (permission/question karty — v2 ich potrebuje)
- `src/components/whirl/thread/*`, `markdown.tsx`, `message-action-button.tsx` (prežili)
- Backend: `server.js` gateway, `server/control.mjs`, `server/runtimes.mjs`,
  `server/store.mjs`, `server/titles.mjs`, SSE, queue, changes artifact, titulky.

### Čo sa odstraňuje (moje nové UI, ktoré používateľ nechce)
- `src/workbench-app.tsx`, `src/components/whirl/editor.tsx`,
  `src/components/whirl/thread/run-card.tsx`,
  `src/components/whirl/project-files-dialog.tsx`,
  `src/components/whirl/pages/context-library.tsx`
- Live output (Herdr neexistuje) a "Ready to continue" stavové texty.

### Zdroje pôvodných zdrojákov
1. `/tmp/opencode/recovered/**` — rekonštruované z opencode session DB (tool
   write/edit calls pred 6. 10. 2026). Použiteľné pre všetky zmazané komponenty:
   `chat-view.tsx` (320), `sidebar.tsx` (287, mierny drift v SessionRow — treba
   skontrolovať), `system-panel.tsx` (206), `pages/home-view.tsx` (255),
   `pages/history-view.tsx` (133), `pages/clips-view.tsx` (141),
   `search-palette.tsx` (131), `session-menu.tsx` (140), `dialogs.tsx` (69),
   `model-menu.tsx` (139), `rename-dialog.tsx` (76), `assistant-panel.tsx` (168),
   `App.tsx` (673; data-layer sa aj tak prepisuje na v2).
2. `git show 86fcdd3:<path>` — staršia kompletná verzia UI (App.tsx,
   src/features/*, components/app-sidebar.tsx) vhodná na krížovú kontrolu.
3. Aktuálny repo — prežívajúce komponenty: `chat-row.tsx`, `home-intro.tsx`,
   `markdown.tsx`, `message-action-button.tsx`, `interaction-card.tsx`,
   `thread/*` (thread-view 148 riadkov je finálny), `styles/whirl/*` (CSS prežil),
   `lib/utils.ts` (formátovacie helpery prežili).

---

## 2. Cieľová architektúra

```text
Browser
 ├─ App.tsx (obnovený shell: sidebar, home, chat, history, clips, usage,
 │            system panel, search palette, session menu, dialogs)
 ├─ SSE /api/v2/events → cielené aktualizácie TanStack cache
 ├─ server queue (v2 commands) namiesto klientského outboxu
 └─ lib/api.ts = ADAPTER: pôvodné signatúry, implementácia cez /api/v2
                 │
Gateway (server.js) → /api/v2/* → Control (SQLite, runtimes)
```

- **Live output sa neobnovuje** (Herdr je preč, `getAgentOutput` nebude volaný).
- **"Ready to continue" pill sa neobnovuje**; namiesto neho tichý stav
  ("Working" / nič). `statusLabel` môže ostať pre iné stavy, ale `idle` nesmie
  renderovať "Ready to continue".
- **"agents" v Overview**: bežiace konverzácie (`resumeStatus === 'working'`)
  mapované na `Agent` tvar s `paneId = conversationId`, aby sidebar "LIVE"
  sekcia fungovala. Žiadne Herdr panes.
- **Queue**: serverová (`session.queued`), composer posiela follow-up hneď;
  fronta sa zobrazuje v chate (remove, model, pause/resume) — prevzaté z novej
  logiky, ale v starom vizuáli.

---

## 3. Kontrakt adaptéra `src/lib/api.ts` (dodá orchestrátor)

Pôvodné signatúry, v2 implementácia. Všetky cesty cez `api()` s prefixom `/api/v2`.

| Funkcia | v2 podklad |
|---|---|
| `getOverview()` | `/bootstrap` + `/system` (+ projekty → directories, bežiace → agents) |
| `getSession(id, limit)` | `GET /conversations/:id` |
| `getSessionUpdates(id, since)` | `GET /conversations/:id`, porovnanie `updated` (fallback; primárne SSE) |
| `getOlderMessages(id, before)` | `GET /conversations/:id?before=` |
| `getHistory(params)` | `GET /conversations?q&cursor` + mapovanie na `total` |
| `getClips()` | `GET /clips?projectId=all` → legacy `Clip` tvar |
| `getModels()` | `GET /models` → `{models: ModelOption[]}` |
| `getSystem()` | `GET /system` |
| `getSystemHistory()` | `GET /system/history` |
| `getProcesses()` | `GET /processes` |
| `killProcess(pid, signal)` | `POST /processes/:pid/kill` |
| `regenerateSessionTitle(id)` | `POST /conversations/:id/title` → `{title}` |
| `setSessionMeta(id, patch)` | `GET` + `PATCH /conversations/:id` (s revision) |
| `setSessionModel(id, model)` | `PATCH /conversations/:id` |
| `postJson(url, body)` | nezmenené (volajúci používajú v2 cesty) |
| `getAgentOutput(agent)` | odstránené / nevolané |

---

## 4. Backend endpointy (Agent A, iba `server/control.mjs`)

Prevziať implementácie zo starého `server.js` (v opencode DB / z kontextu):

1. `GET /system` → `{ load[], cpuCount, memoryTotal, memoryFree, memoryUsed,
   memoryPercent, swap{total,free,used}, uptime, cpu{percent,cores},
   disk{total,free,used,percent}, sampledAt }`
2. `GET /system/history` → `{ samples:[{t,cpu,memoryPercent,memoryUsed}], intervalMs:15000 }`
   (ring buffer 240 vzoriek, sampler každých 15 s; CPU % len zo sampleru)
3. `GET /processes` → `{ processes:[{pid,cpu,memory,etimes,user,name,args}] }`
   (ps, max 25, --sort=-pcpu)
4. `POST /processes/:pid/kill {signal}` → rovnaké obmedzenia ako pôvodne:
   iba rovnaký UID, odmietnuť `process.pid`/`process.ppid`, signály
   SIGTERM/SIGKILL/SIGINT.
5. `POST /assistant` → SSE streaming read-only asistent pre Ask panel:
   - body `{ conversationId, messages:[{role,content}] }`
   - odpoveď `text/event-stream`, riadky `data: {"delta":"..."}\n\n`,
     na konci `data: {"done":true}\n\n`, chyby `data: {"error":"..."}\n\n`
   - kontext: text posledných ~60 správ konverzácie (max 8000 znakov)
   - model: `opencode-go/deepseek-v4-flash` cez `https://opencode.ai/zen/go/v1`
     (kľúč z `~/.local/share/opencode/auth.json`), `max_tokens: 1200`
   - bez kľúča → 503 s jasnou chybou (panel zobrazí chybu)

Do `check`/testov doplniť aspoň smoke volania `/system` a `/processes`.

---

## 5. Rozdelenie práce medzi agentov

### Agent A — backend compat (`server/control.mjs` ONLY)
- Implementovať body 1–5 z kapitoly 4.
- Pridať do existujúceho `prune` intervalu nič nemeniť; sampler ako `setInterval(...).unref()`.
- Nesmie meniť existujúce v2 routes, schému DB, ani iné súbory.
- Verifikácia: `node --check server/control.mjs`, `curl` na nové endpointy
  cez `http://127.0.0.1:8788` s `x-workbench-internal-key` z
  `~/.config/secrets/workbench-cloudflare-secrets.json`.
- **Nerestartovať služby** (orchestrátor to spraví po integrácii).

### Agent B — shell (`src/App.tsx` + sidebar + prehľady)
Súbory: `src/App.tsx` (nový, z `/tmp/opencode/recovered/src/App.tsx`),
`src/components/whirl/sidebar.tsx`, `system-panel.tsx`, `search-palette.tsx`,
`session-menu.tsx`, `rename-dialog.tsx`, `dialogs.tsx`.

- Vychádzať z recovered verzií; **layout a JSX zachovať** (sidebar s brandom,
  LIVE sekcia, projekty/directories, recent, footer s témou/logout; dialogs
  bez OutputDialog — live output sa neobnovuje; NewTaskDialog nahradiť
  v2 tokom alebo ponechať nepoužitý).
- Data layer prepísať na adaptér z kapitoly 3 + SSE (`/api/v2/events`) cez
  `EventSource` s cielenými invalidáciami (nie plošný refetch).
- Sidebar props prispôsobiť v2 svetu (Overview z adaptéra), zachovať vzhľad.
- Performance panel `SystemPanel` napojiť na `getSystem`, `getSystemHistory`,
  `getProcesses`, `killProcess`; "live tasks" = bežiace konverzácie.
- `#live/` pane routing odstrániť.
- Verifikácia: `npx tsc --noEmit` (ignorovať chyby v cudzích súboroch).

### Agent C — chat a home
Súbory: `src/components/whirl/chat-view.tsx`, `model-menu.tsx`,
`pages/home-view.tsx`, `composer.tsx`, `assistant-panel.tsx`.

- `chat-view.tsx`: recovered verzia; odstrániť live-output/terminal prvky a
  "Ready to continue"; queue čítať zo `session.queued` (server), zobraziť
  `InteractionCard` pre `session.interactions`; stop/resume cez
  `POST /conversations/:id/stop|resume`; starý `queued` prop nahradiť.
- `model-menu.tsx`: v2 `/models` + `PATCH /conversations/:id` (meniť model
  počas behu = "Applies next turn" náznak, žiadny fake stav).
- `home-view.tsx`: pôvodné chips (priečinky z `directories`) + kind
  opencode/pi; štart úlohy = `POST /conversations` + `POST /conversations/:id/commands`
  (žiadne `/api/tasks`); podpora projektov z bootstrapu.
- `composer.tsx`: vrátiť recovered verziu (273 riadkov); doplniť queue-friendly
  placeholder (follow-up čaká vo fronte).
- `assistant-panel.tsx`: prepísať z `@ai-sdk/react` na jednoduchý fetch
  streaming proti `POST /api/v2/assistant` (protokol z kapitoly 4).
- Verifikácia: `npx tsc --noEmit`.

### Agent D — stránky, čistenie, integrácia
Súbory: `src/components/whirl/pages/history-view.tsx`, `clips-view.tsx`,
`pages/usage-view.tsx` (len napojenie), `thread/*` (kontrola kompatibility),
+ mazanie nových UI súborov.

- `history-view.tsx`, `clips-view.tsx`: recovered verzie napojené na adaptér.
- `usage-view.tsx`: zostáva nový; iba skontrolovať, že funguje s adaptérom
  a `model-picker.tsx` (tie nemeniť).
- Zmazať: `src/workbench-app.tsx`, `src/components/whirl/editor.tsx`,
  `thread/run-card.tsx`, `project-files-dialog.tsx`, `pages/context-library.tsx`.
- Skontrolovať, že thread komponenty sedia s legacy chat-view (props).
- Verifikácia: `npx tsc --noEmit`.

---

## 6. Pravidlá pre agentov

1. **Nespúšťať** `npm run build`, `npm run deploy`, `wrangler`, ani
   `systemctl restart` — build/promote robí orchestrátor po integrácii.
2. **Nemeniť** súbory mimo vlastného zoznamu (hlavne nie `server/*`,
   `lib/api.ts`, `lib/types.ts`, `lib/format.ts` — tie dodá orchestrátor).
3. Držať sa existujúcich Whirl štýlov a tried (`bg-well`, `raised`, `wb-scroll`,
   `text-muted-foreground`, …). Žiadny nový dizajn.
4. Žiadne secrets, žiadne osobné cesty v kóde.
5. Report na konci: zoznam zmenných súborov, čo funguje, čo je nedokončené.

## 7. Finálna verifikácia (orchestrátor)

- `npx tsc --noEmit`, `npm run check`, `npm test`.
- `npm run build` + promote; kontrola `public/index.html`.
- `curl` smoke: `/system`, `/processes`, `/assistant`, `bootstrap`, event stream.
- Manuálny E2E cez gateway: nová konverzácia → beh → changes artifact →
  stop/resume → usage.
- Ak treba, doplniť chýbajúce veci a až potom prípadný commit/push.

---

## 8. Stav implementácie (dokončené)

- **Backend:** `server/control.mjs` má `/system`, `/system/history`, `/processes`,
  `/processes/:pid/kill` (obmedzenia ako pôvodne) a `/assistant` (SSE streaming
  read-only asistent cez OpenCode Go). Overené curlom.
- **UI:** obnovené pôvodné Whirl UI zo 5. 10. — `App.tsx`, `sidebar`,
  `chat-view`, `home-view`, `model-menu`, `composer`, `assistant-panel`
  (prepísaný z AI SDK na vlastný streaming), `system-panel` (performance panel),
  `search-palette`, `session-menu`, `rename-dialog`, `history-view`, `clips-view`.
  `usage-view` zostal nový (používateľ ho chce).
- **Odstránené:** live output, `OutputDialog`, "Ready to continue", moje nové
  UI súbory (`workbench-app`, `editor`, `run-card`, `project-files-dialog`,
  `context-library`).
- **Napojenie:** `src/lib/api.ts` je adaptér pôvodných signatúr na `/api/v2`,
  `App.tsx` používa SSE (`/api/v2/events`) s cielenými invalidáciami,
  serverovú frontu (`session.quoted`/`queued` → remove), stop/resume, model
  a meta cez v2.
- **Overené:** `npm run check`, `npm test` 7/7, `workbench.smoke.mjs` (oba
  engine-y), `workbench.workflow-test.mjs` (attachment, zmena modelu, pauznutá
  fronta, SSE). Build promovaný, assety 200 cez gateway.
