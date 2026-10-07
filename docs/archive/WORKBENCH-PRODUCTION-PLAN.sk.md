# Workbench: hĺbkový audit a produkčný plán

**Dátum:** 5. október 2026

**Projekt:** `~/projects/Workbench`

**Cieľ:** vlastné rýchle, intuitívne agentické UI so zachovaním súčasného vizuálneho štýlu.

## 1. Rozhodnutie v skratke

Workbench dnes funguje ako webové diaľkové ovládanie terminálových agentov. Jeho hlavný problém je **nejasné vlastníctvo stavu konverzácie a dve rôzne vykonávacie cesty**, nie farby, React alebo samotný výber modelu.

Odporúčaná prestavba:

1. **Jeden produktový model: projekt → konverzácia → používateľská požiadavka → beh → výsledky.** Konverzácia existuje nezávisle od procesu agenta.
2. **OpenCode headless server + typované API ako prvý runtime.** Odstrániť ovládanie TUI cez klávesy a spúšťanie nového `opencode run` na každé pokračovanie.
3. **Workbench vlastní prijatie správ, frontu, stav behov, modelové preferencie, projekty, usage a event log.** Runtime vlastní svoj agent loop a natívny kontext. Workbench má z neho rekonštruovateľnú projekciu pre UI.
4. **HTTP príkazy + SSE udalosti**, okamžitá optimistická správa, reconnect s replayom a zosúladením stavu.
5. **Univerzálny model picker nad pripojeniami a schopnosťami.** Model, provider, účet/plan a agent runtime sú rozdielne entity.
6. **Projektová knižnica kontextu namiesto izolovaného clipboardu.** Projekt je stabilná identita naviazaná na skutočný priečinok a prípadné worktrees.
7. **Pi SDK ako druhý runtime za rovnakým rozhraním**, až po skúške autentifikácie, kvality, obnovy a reálnej spotreby. Nie slepá výmena CLI.

**Vizuál zachovať.** Odstrániť `Live output`, terminálové ovládacie prvky a trvalé `Ready to continue`. Nahradiť ich kontextovými informáciami: agent pracuje, čaká na odpoveď, zmenil súbory, testy prešli, úloha zlyhala.

### Čo znamená „nepracovať cez CLI“

Používateľ nemá ovládať terminál a aplikácia nemá parsovať jeho obrazovku. Agent môže technicky bežať ako samostatný proces. Dôležité je, že ho riadime **stabilným štruktúrovaným protokolom**, nie písaním klávesov do TUI.

OpenCode server, Pi SDK/RPC, Codex app-server a Claude Agent SDK všetky umožňujú vlastné UI. Claude SDK pritom tiež spúšťa binárku Claude Code. „SDK“ automaticky neznamená nižšiu RAM ani absenciu subprocessov.

## 2. Čo bolo overené

Audit zahŕňal frontend, backend, edge proxy, systemd konfiguráciu, runtime integráciu, lokálne verzie nástrojov, agregáty databázy a existujúce kontroly.

### 2.1 Aktuálna architektúra

```text
React 19 + Vite + TanStack Query + Whirl komponenty
             │ HTTP + polling
Cloudflare Worker: login / session / proxy
             │ WORKBENCH_API, VPC Service binding
Node server.js na VPS, 127.0.0.1:8787
 ├─ Herdr CLI → workspace/pane → OpenCode alebo Pi TUI
 ├─ systemd-run → opencode run --session ... pri saved chate
 ├─ read-only čítanie internej OpenCode SQLite
 ├─ JSON súbory: preferencie, metadáta, clips
 └─ ai.mjs: priame AI SDK volania pre title/tags a pomocný Ask panel
```

`@ai-sdk/react` a `ai` už sú nainštalované, ale hlavný agentický chat cez ne nejde. Streamovaný je pomocný read-only asistent, zatiaľ čo hlavný chat získava zmeny pollingom.

### 2.2 Lokálne merania

Ide o jednorazový snapshot počas auditu, nie o záťažový benchmark ani produkčné p95.

| Oblasť | Pozorovanie |
|---|---|
| Node | `v22.22.1` |
| OpenCode | `1.18.34` |
| Pi | `0.87.1`, balík `@earendil-works/pi-coding-agent` |
| VPS | približne 3 814 MiB RAM; 1 803 MiB z 2 047 MiB swapu obsadených |
| RAM pri meraní | približne 688 MiB free, 1 423 MiB available |
| Workbench služba | `workbench-console.service`, `MemoryMax=160M` |
| Cgroup služby | približne 158,4 MiB current, 160 MiB peak |
| Cgroup memory.events | `max=532`, `oom=0`, `oom_kill=0` |
| Dva existujúce OpenCode procesy | RSS približne 898 MiB a 803 MiB; ide o živé TUI procesy, nie headless benchmark |
| JS asset | 1 002 414 B, lokálne gzip 297 438 B |
| CSS asset | 88 641 B, lokálne gzip 16 830 B |
| OpenCode DB | 73 sessions, 6 752 messages, 34 214 parts |
| Child sessions | 49 zo 73 majú `parent_id`; iba 24 je top-level |
| Priradenie | 62 sessions má directory `~`, z toho 47 child sessions |
| Najdlhší thread | 1 167 správ |
| Obsah parts | približne 195,6 milióna znakov; najväčší part približne 5,64 milióna znakov |
| OpenCode credentials | `openai: oauth`, `opencode-go: api`; hodnoty kľúčov neboli vypísané |
| Pi uložené credentials | prázdny auth store; tým nie je vylúčené pripojenie cez environment |

Lokálne GET požiadavky, tri sekvenčné vzorky na endpoint, bez Cloudflare a bez generovania odpovedí:

| Endpoint | Časy | Veľkosť odpovede |
|---|---|---|
| health | 321 / 25 / 8 ms | ~240 B |
| overview | 165 / 52 / 40 ms | 53 387 B |
| posledných 30 správ najdlhšieho threadu | 171 / 139 / 122 ms | 79 582 B |
| updates bez zmeny sledovaného threadu | 33 / 39 / 17 ms | 65 B |

Záver: malé API odpovede už vedia byť rýchle. Výrazné oneskorenia produktu vytvára aj orchestrace a polling, nielen výkon servera. Cgroup naráža na limit, ale meranie **nepreukázalo OOM kill ani memory leak**. Obsadený swap sám osebe nepreukazuje aktuálne swapovanie.

### 2.3 Kontroly a hranice dôkazov

- `npm run check` prešlo.
- `npm run test:ai` prešlo: 6 testov. Testujú utility title/tags/prompt/schema, nie doručenie správ alebo životný cyklus agenta.
- Repo obsahuje rozsiahle rozpracované zmeny oproti jedinému commitu. Tento audit vychádza z aktuálnych súborov, nie zo starej verzie v Gite.
- Nebol vykonaný browser profiling, Lighthouse, platený modelový benchmark ani reálny Pi coding run.
- HTTP `/doc` už bežiaceho OpenCode procesu vrátilo 403. Konkrétny serverový kontrakt nainštalovanej verzie sa preto musí overiť v izolovanom stagingu. Aktuálna verejná dokumentácia nemusí presne zodpovedať verzii `1.18.34`.
- Internú implementáciu v0/Bolt nemožno odvodiť z pocitu z ich UI. Sú UX referenciou, nie dôkazom konkrétneho backendu alebo nižšej spotreby.

## 3. Nálezy: čo dnes spôsobuje problémy

### P0 — správnosť a strata vstupov

| ID | Nález a dôkaz | Dôsledok | Náprava |
|---|---|---|---|
| F01 | Dve cesty: `server.js:1292–1356` verzus `1432–1471`, vytvorenie `1486–1542` | Iné správanie send/stop/model/images/permissions podľa toho, či existuje pane | Jednotný command dispatcher cez runtime adaptér |
| F02 | `App.tsx:401–422` posiela iba directory/prompt/title/kind | Prílohy viditeľné pri prvom prompte sa neodošlú a po úspechu sa vymažú | Rovnaký MessageInput kontrakt pre prvú aj ďalšie správy |
| F03 | Backend vracia `promptSubmitted:false` a warning, `App.tsx:415–429` číta iba paneId | UI oznámi úspech a vymaže vstup, aj keď prvý prompt nebol potvrdený | Trvalý accepted/dispatching/uncertain stav s dohľadaním výsledku |
| F04 | Drafty/outbox sú iba `useState`, `App.tsx:102–105,165–172` | Reload/zatvorenie tabu stratí draft aj prijatý follow-up; `.slice(-20)` navyše potichu odstráni najstaršiu queued správu | IndexedDB pre drafty, DB pre prijaté príkazy; explicitný queue limit |
| F05 | `sendPrompt` nechá editor editovateľný, ale po await vymaže celý draft, `App.tsx:358–396` | Text dopísaný počas pomalého sendu môže zmiznúť | Snapshot odoslanej verzie, optimistické odobratie iba tejto verzie; novší draft zachovať |
| F06 | Dohadovanie session cez rovnaké cwd a najnovšiu session v posledných 2 h, `server.js:1066–1082` | Dve úlohy v rovnakom projekte sa môžu spojiť s nesprávnym chatom; bez filtra runtime môže byť nesprávne priradený aj Pi pane | Explicitná väzba conversationId ↔ runtimeSessionId vytvorená pred promptom |
| F07 | Pi možno spustiť, ale transcript/resume/model API číta iba OpenCode DB, `server.js:19,100–155,1498` | Pi je vo výbere bez implementovanej end-to-end konverzačnej integrácie | Capability-gated runtime; Pi sprístupniť až s adapter conformance testami |
| F08 | Saved-run stdout/stderr sú `null`; systemd `failed` sa mapuje na idle, `server.js:455–464,1327–1328` | Zlyhanie, OOM, timeout a normálne dokončenie nemajú odlíšený produktový stav | Persistovať dôvod ukončenia, exit status a sanitizovanú diagnostiku |

### P1 — responzivita, modely a konzistencia

| ID | Nález a dôkaz | Dôsledok | Náprava |
|---|---|---|---|
| F09 | Polling session 3,5 s, overview 10 s, system 20 s, `App.tsx:110–125,309–348` | Samotný session interval pridáva pri rovnomernom príchode zmien priemerne ~1,75 s čakania, pred sieťou/renderom | Push eventy, okamžitý lokálny feedback |
| F10 | New task čaká na workspace/start/prompt; kroky majú rozpočty 15/50/25 s, `server.js:1501–1524` | HTTP prijatie úlohy je previazané s pomalým bootstrapom | 202 až po durable zápise, bootstrap asynchrónne |
| F11 | Updates vracajú len posledných 20 správ, `server.js:1272–1290` | Ak pribudne viac správ medzi fetchmi, merge môže vytvoriť dieru v už načítanej histórii | Sekvenčný cursor, gap detection a range fetch/snapshot |
| F12 | `row.updated` je jediná revízia, preference/metadáta sú mimo DB | Nie je to spoľahlivý cursor všetkých doménových zmien; cross-device model/title zmena nemusí prísť | Workbench event sequence + entity revisions |
| F13 | `changeModel` ukladá iba JSON preference, `App.tsx:498–510`, `model-menu.tsx:130–133` | Vybraný model sa tvári aktívne, ale živý agent používa pôvodný | Zvolený ďalší model oddeliť od skutočne použitého; model explicitne na turn |
| F14 | Home nemá model picker; `startTask` model neposiela | Prvý turn nemá jednotný default ani explicitnú voľbu | Rovnaký picker na Home aj v konverzácii |
| F15 | Modely: spawn CLI, dočasný auth copy, 10-min cache, `server.js:663–692` | Cold fetch môže trvať dlho, súbežné missy spustia viac procesov; procesy dedia cgroup služby | Runtime catalog API, single-flight refresh, uložený last-known-good catalog |
| F16 | Validácia modelu iba regexom, `server.js:1693–1703` | Uložiť možno model neprístupný danému účtu alebo runtime | Kontrola connection/model/runtime/capabilities aj pri dispatchi |
| F17 | Celý shell závisí od overview/Herdr, `App.tsx:547–565`, `server.js:1061–1092` | Výpadok terminálovej vrstvy zablokuje aj čítanie existujúcich chatov | Samostatný rýchly bootstrap z Workbench DB a nezávislý runtime health |
| F18 | `systemctl` pri každom session updates, subprocessy Herdr pri overview | Polling vytvára opakovanú systémovú prácu podľa počtu tabov | Runtime supervisor a cached health events |
| F19 | `persistModelPrefs` a `persistSessionMeta` používajú spoločný temp názov bez serializácie, `server.js:650–654,755–759` | Súbežné zápisy môžu kolidovať; memory state sa zmení aj pri zlyhaní persistencie | Transakcie SQLite a optimistic concurrency |
| F20 | Send/queue/stop sa rozhoduje podľa zastaraného frontend statusu; `sendingSessionId` je globálne | Multi-tab race a nejednotné správanie; odosielanie v jednom chate blokuje druhý | Server autorita, per-conversation single writer, per-command pending state |

### P1/P2 — projekty, agent workflow a frontend

| ID | Nález a dôkaz | Dôsledok | Náprava |
|---|---|---|---|
| F21 | Projekt je prvý level `~/projects` alebo HOME, filter je exact string directory, `server.js:334–364,1095–1101` | Subdirectory, worktree, presun priečinka a general chat nemajú správnu identitu | Project registry + canonical roots + workspace bindings |
| F22 | `parentID` sa načíta, ale top-level query ho nefiltruje, `server.js:103–111` | Sidebar/history miešajú hlavné konverzácie a 49 child sessions | Root conversations štandardne; subagents vo vnútri rodiča |
| F23 | Clipboard nemá project/session scope, `types.ts:117–125`, `clips-view.tsx`, `server.js:1544–1606` | Clips nesúvisia s otvoreným projektom a nemožno ich priamo vložiť z knižnice do správy | Scoped context library + Attach to conversation |
| F24 | Clipboard nemá realtime aktualizáciu; nový UI build vypína focus refetch globálne | „Sync between devices“ sa neprejaví spoľahlivo v už otvorenom view | Clip events cez spoločný stream |
| F25 | History zväčšuje limit na max 100 bez cursoru, `history-view.tsx:100–108` | Nad 100 výsledkov sa Load more prestane posúvať | Keyset pagination |
| F26 | Search používa pôvodný DB title a iba posledný 240-char preview, `server.js:1102–1112` | Premenovaný chat a obsah starších správ sa hľadajú nekonzistentne | FTS index nad vlastnou projekciou a aktuálnym titulkom |
| F27 | Scroll revision neobsahuje text/jeho verziu, `thread-view.tsx:53–67` | Rast rovnakého textového partu nemusí vyvolať autoscroll | Explicitná render revision, ResizeObserver, stabilný scroll anchor |
| F28 | Jediný JS bundle, eager importy panelov v `App.tsx`, highlight vo všetkých Markdown blokoch | Parsery a pomocné panely sú v initial loade; veľké thready rastú bez virtualizácie | Lazy routes/panels, viewport rendering, inkrementálne bloky |
| F29 | `mergeSession` kopíruje/sortuje celú načítanú históriu pri update | Práca rastie s počtom správ; render props/callbacks vznikajú v centrálnom App | Normalizovaný store, stabilné entity a selektory |
| F30 | Tool details majú text outputu už v DOM aj pri zavretom details | Zbalenie vizuálu neodstráni sieťový/DOM náklad | Output/artifact fetch až pri otvorení |

### Prevádzkové nálezy

- **Limit backendu:** služba má 160 MiB vrátane cgroup účtovania, pritom parsuje JSON, SQLite parts, až 30 MB request bodies a spúšťa pomocné procesy. Limity uploadu a concurrency treba dimenzovať spoločne, nie oddelene.
- **Admission control:** `os.freemem() < 1 GiB` nie je scheduler. Pri meraní free/available ukazovali odlišný obraz. Potrebný je `MemAvailable`, cgroup headroom, procesné budgety a sledovanie pamäťového tlaku.
- **Static delivery:** `worker.js:111–130,254–255` posiela assety najprv na VPS; `ASSETS.fetch` použije až pri 404. Zhoršuje to dostupnosť shellu a ruší výhodu edge assetov.
- **Deploy race:** `scripts/promote-ui-build.mjs:26–36` zmaže staré hashované assety ešte pred výmenou indexu. Otvorený starý index môže dostať 404 na svoj asset. Neskôr by tým trpeli aj lazy chunks.
- **Pozorovateľnosť:** Worker má zapnutú observability, ale nie explicitne traces. Backend nemá correlation IDs a trvalé run errors.
- **Runtime dáta:** `.gitignore` nepokrýva `data/session-meta.json` a `data/session-models.json`. Produkčný dátový adresár oddeliť od release a repozitára.
- **Procesné oprávnenia:** API vie ukončiť ľubovoľný proces rovnakého UID mimo seba a parenta (`server.js:1622–1639`). Bežný Stop má pracovať iba s vlastneným run/cgroup. Globálny process manager oddeliť ako administrátorskú funkciu.
- **Sandbox hranica:** `ProtectHome=read-only` na Workbench API sa nedá automaticky považovať za sandbox procesov spustených cez user systemd manager alebo Herdr. Izoláciu treba nastaviť priamo na vykonávacom prostredí.
- **Ask panel:** je ďalší samostatný read-only chat, má iba textový chvost transcriptu do 8 000 znakov a hardcoded Go model. Jeho usage dnes nevstupuje do centrálneho prehľadu.
- **SW:** súbor `public/sw.js` existuje, ale `src/main.tsx:23–27` registrácie odstraňuje. Aktívnu offline/PWA vrstvu preto nemožno predpokladať.

## 4. Výber agent runtime

### 4.1 OpenCode headless: prvá produkčná cesta

Verejná dokumentácia podporuje:

- `opencode serve`, HTTP API a JS/TS SDK `@opencode-ai/sdk`;
- vytvorenie session pred prvým promptom;
- message/prompt endpoint s explicitným modelom;
- asynchrónne prijatie promptu;
- event stream, status, abort, permission odpovede;
- provider discovery, session history, todo, diff a fork.

**Prečo začať tu:** máme existujúce sessions, OpenAI OAuth, Go credentials a zavedené coding správanie. Najväčší prínos dosiahneme odstránením Herdr/TUI cesty bez súčasnej výmeny celého agent loopu.

Implementačné pravidlá:

1. Supervisor spustí headless server ako samostatnú službu, nie pri každom HTTP requeste.
2. API sa pripája cez loopback/autentifikované interné rozhranie. Runtime port sa nezverejňuje pre browser.
3. Verzia binárky a SDK je pinovaná a testovaná ako jeden kontrakt. Pri štarte overiť health/verziu.
4. Overiť skutočnú podobu permission/question API, eventov a práce s directory z OpenAPI nainštalovanej verzie. Nepreberať názvy endpointov naslepo z najnovšieho webu.
5. Nové Workbench sessions viesť cez explicitné runtime IDs; žiadne odhady podľa cwd/title.
6. Pre prvý single-user pilot jeden runtime server so serializáciou zápisov do rovnakého workspace. Multi-workspace izoláciu rozšíriť podľa nameraných budgetov.
7. Per-project kontajnery/procesy spúšťať podľa potreby a nechať zaniknúť pri idle. Neudržiavať jeden proces pre každý historický chat.

Headless server nemusí byť výrazne menší než TUI. Očakávaný prínos je odstránenie cold-startu na každú správu, deterministické ovládanie a menej súbežných runtime procesov. RAM treba zmerať.

### 4.2 Pi: skutočne vhodný kandidát, ale až s adapterom

Lokálne nainštalovaná verzia už má:

- `createAgentSession()` pre embedding v Node/Bun;
- `SessionManager` s perzistentným kontextom, vetvením a compaction;
- event subscription, `steer()`, `followUp()`, `abort()`;
- RPC s koreláciou request ID, `set_model`, `get_available_models`, session stats;
- `agent_settled`: dôležitejší signál konca než samotný `agent_end`, po ktorom môže pokračovať retry/compaction/follow-up;
- natívny `opencode-go` provider s odlišnými API protokolmi a `x-opencode-session` headerom.

**Preferované nasadenie pre Workbench:** Pi SDK v izolovanom runner procese. API server nemá priamo hostovať agent loop a extensions. Alternatívou pre procesný boundary je Pi RPC; to je štruktúrovaná integrácia, nie terminálové ovládanie.

Dôležité detaily:

- `SessionManager` je autorita pre rekonštruovaný modelový kontext; nestačí prepísať `agent.state.messages`.
- Pri výmene runtime session treba obnoviť event subscriptions.
- Pri RPC čítať stdout nepretržite, rešpektovať backpressure a JSONL deliť na LF.
- Pi `abort` môže dovoliť pokračovať ponechaným queued správam. Workbench Stop musí mať explicitnú queue policy; bezpečnejšie je follow-up frontu vlastniť na úrovni Workbench a posielať ju až pri dispatchi.
- Základné Pi neposkytuje rovnakú permission UX ako OpenCode. Capability map musí byť pravdivá; podporu schvaľovania doplniť extension/tool policy vrstvou tam, kde ju produkt potrebuje.
- OpenAI OAuth v OpenCode auth store nie je automaticky prihlásenie v Pi. Overiť podporovaný login flow a účtovanie; nekopírovať refresh tokeny medzi dvoma vlastníkmi bez vyriešenia refresh koordinácie.

### 4.3 Codex a Claude: čo si zobrať

| Integrácia | Základný model | Použitie vo Workbench |
|---|---|---|
| Codex app-server | Thread → turn → item, JSON-RPC, lifecycle udalosti, model discovery, steer/interrupt, auth a rate-limit API | Výborná referencia doménového modelu; neskôr samostatný adapter, ak potrebujeme natívny Codex workflow/plan telemetry |
| Claude Agent SDK | Agent loop Claude Code, sessions, tools, hooks, permissions, subagents cez Python/TS | Neskorší špecializovaný adapter, nie univerzálna multi-provider vrstva |
| Priame model API + vlastný loop | Úplná kontrola nad nástrojmi a orchestráciou | Vhodné pre úzke pomocné funkcie; kompletný coding harness by výrazne zväčšil scope a riziko regresií |

Codex dokumentácia označuje WebSocket transport za experimentálny/nepodporovaný pre produkciu; pre prípadný adapter preferovať lokálny podporovaný kontrakt a overiť status presnej verzie. Claude Agent SDK používa Claude Code binary a pre vlastný produkt štandardne API-key autentifikáciu; nepredpokladať prenesenie osobného claude.ai plánu.

**Odporúčanie:** prvé produkčné vydanie podporuje kompletne OpenCode. Pi má samostatný experimentálny switch po úspešnom bake-off. Codex/Claude sa nepridávajú iba preto, aby picker obsahoval viac log.

### 4.4 Runtime bake-off

Rovnaký izolovaný checkout, rovnaká úloha, model a účet všade, kde to protokoly umožňujú. Rozdielny harness znamená rozdielny system prompt, takže merať výslednú kvalitu, nielen tokens/s.

Testovacie scenáre:

1. Malá viac-súborová oprava s existujúcimi testami.
2. Analýza väčšieho repozitára bez úprav.
3. Screenshot + text v prvom aj ďalšom prompte.
4. Dlhšia session, compaction a prechod na menší context model.
5. Follow-up počas práce, stop, otázka používateľovi.
6. Zmena modelu/connection medzi turnmi.
7. API reštart, runner reštart, výpadok browser spojenia.
8. Dve izolované úlohy a dva otvorené klienty.

Merať: cold/warm startup, model TTFT, orchestration delay, úspešnosť úloh, čas do hotového výsledku, usage/cost, idle/peak RSS, CPU a zlyhania obnovy. Pi sa stane defaultom až vtedy, keď preukáže významný prínos bez straty dôležitých schopností. V tomto audite sa takýto násobok výkonu nepotvrdzoval.

## 5. Cieľová architektúra

```text
Browser: React + Whirl
 ├─ lokálne drafty / pending commands (IndexedDB)
 ├─ normalizovaný transcript store
 ├─ TanStack Query: zoznamy, history, settings
 └─ HTTP commands + jeden multiplexovaný SSE stream na klienta
                 │
Cloudflare Worker
 ├─ auth/session + konzistentné security headers
 ├─ ASSETS.fetch pre shell, JS, CSS, fonts
 └─ streaming proxy pre API/eventy
                 │
Workbench API / control service
 ├─ command validation + idempotency
 ├─ SQLite WAL: domain state, durable queue, events, usage
 ├─ transcript projekcie a FTS
 ├─ attachment/artifact store
 └─ runtime supervisor + reconciler
                 │
Runtime adapter boundary
 ├─ OpenCode headless API
 └─ Pi SDK runner [neskôr]
                 │
Workspace / worktree / izolované nástroje
```

### 5.1 Jednoduchý deployment, jasné hranice

Na tomto VPS postačí modulárny Node/TypeScript backend, SQLite WAL a oddelený runner. Redis, Kafka, Kubernetes a päť mikroservisov by na začiatku pridávali viac prevádzky než hodnoty.

- SQLite je vhodná pre single-host/single-user alebo malý počet používateľov pri krátkych transakciách.
- DB prácu robiť s obmedzenými výsledkami; veľký import/indexáciu presunúť mimo request event loop.
- Veľké tool outputs a prílohy sú blob/artifact dáta, nie text v každom session JSON.
- API a runner majú samostatné pamäťové budgety a lifecycle.
- Vykonávanie dlhého runu nezávisí od HTTP requestu alebo otvoreného browsera.
- „Produkcia“ pre prvú fázu znamená spoľahlivý privátny Workbench na jednom hoste. Verejný multi-tenant SaaS vyžaduje samostatný access/isolation model a nie je len ďalšie nastavenie súčasného hesla.

### 5.2 Vlastníctvo dát

**Workbench je autorita pre:** user intent, accepted commands, conversation IDs, queue, execution binding, run stav, preferencie, UI metadata, usage ledger a udalosti doručované klientom.

**Runtime je autorita pre:** svoj natívny transcript, modelový kontext, tool loop, kompaktované zhrnutia a engine-specific checkpointy.

**Workbench transcript je projekcia:** mapuje natívne message/tool IDs na vlastné entity; dá sa opraviť načítaním natívneho snapshotu. Nezapisujeme priamo do internej OpenCode DB. Starú DB možno použiť na versioned read-only import.

Tým sa vyhneme dvom systémom, ktoré si súčasne myslia, že riadia agentický kontext. Zmena enginu znamená explicitný handoff, nie predstieranie kompatibility natívnych session súborov.

## 6. Kontrakty a dátový model

### 6.1 Hlavné entity

| Entita | Kľúčové polia |
|---|---|
| Project | `id`, `name`, `canonicalRoot`, `status`, `defaultModelSelection`, `instructionsRevision` |
| Workspace | `id`, `projectId`, `canonicalCwd`, `kind: root/worktree/general`, `gitCommonDir`, `branch`, `status` |
| Conversation | `id`, `projectId|null`, `workspaceId`, `title`, `engine`, `modelOverride`, `pinned`, `archivedAt`, `revision` |
| RuntimeBinding | `conversationId`, `engine`, `runtimeInstanceId`, `runtimeSessionId`, `generation`, `capabilitiesVersion` |
| Command | `id`, `clientCommandId`, `conversationId`, `type`, `payloadHash`, `acceptedSeq`, `status`, `createdAt` |
| Turn | Používateľská požiadavka, poradie vo fronte, immutable input/attachment refs, požadovaný model/config snapshot |
| Run | Jeden vykonávací pokus turnu: `attempt`, `status`, `leaseOwner`, `fencingToken`, `heartbeat`, `startedAt`, `endedAt`, `failureCode` |
| Message / Part | Vlastné ID + native ID, role, poradové číslo, verzia, text/tool/artifact referencie, parentRun |
| Interaction | Permission alebo otázka: ID, typ, možnosti, stav, termín, atomicky uložená odpoveď |
| Event | Globálne monotónne `seq`, schemaVersion, entity refs, entityVersion, payload, čas |
| ProviderConnection | Provider, účet alias, auth method, runtime compatibility, secretRef, health, quota capability |
| ModelOffering | Connection + model ID + protokol + capabilities + limity + pricing provenance |
| UsageRecord | Unikátny model request/step, attempt, run, tokens, cache, cost provenance, providerRequestId |
| Attachment / Artifact | Blob hash, MIME, veľkosť, thumbnail, storage key, referencie a retention |
| Clip | `scope`, `projectId`, `sourceConversationId`, typ, title, text/blobRef, pin/tags, timestamps |

`Turn` nie je jedna LLM odpoveď: jedna používateľská úloha môže spustiť mnoho modelových krokov a nástrojov. Retry pokus má nový `Run`, ale zostáva pod pôvodným turnom. Tool failures sa nemusia rovnať zlyhaniu celého runu, ak sa agent zotaví.

Všetky timestampy v DB v UTC; pre radenie a replay používať sekvenciu, nie hodiny klienta.

### 6.2 Runtime adapter

Konceptuálne rozhranie; konkrétne metódy sa prispôsobia verzii engine:

```ts
interface AgentRuntimeAdapter {
  capabilities(): RuntimeCapabilities;
  createSession(input: WorkspaceAndConfig): Promise<RuntimeBinding>;
  getSnapshot(binding: RuntimeBinding): Promise<RuntimeSnapshot>;
  dispatch(binding: RuntimeBinding, command: DispatchCommand): Promise<DispatchReceipt>;
  subscribe(binding: RuntimeBinding): AsyncIterable<NormalizedRuntimeEvent>;
  stop(binding: RuntimeBinding, run: RunRef): Promise<StopReceipt>;
  respond(binding: RuntimeBinding, interaction: InteractionResponse): Promise<void>;
  listModels(connection: ConnectionRef): Promise<ModelOffering[]>;
  health(): Promise<RuntimeHealth>;
}
```

Capabilities zahŕňajú images, file references, model change, steering, follow-up, questions, permissions, usage, compaction, fork, diff a replay/snapshot možnosti. Nepodporované operácie sa neukážu ako funkčné tlačidlá.

### 6.3 Produktové API

Prvá verzia API môže mať tieto zdroje:

```text
GET    /api/bootstrap
GET    /api/projects
POST   /api/projects
GET    /api/conversations?projectId=...&cursor=...
POST   /api/conversations
GET    /api/conversations/:id/messages?before=...
POST   /api/conversations/:id/commands
PATCH  /api/conversations/:id/settings
GET    /api/commands/:clientCommandId
GET    /api/events?after=...
POST   /api/interactions/:id/response
GET    /api/model-offerings
GET    /api/connections
GET    /api/usage?from=...&to=...&projectId=...
POST   /api/attachments
GET    /api/artifacts/:id
GET    /api/clips?scope=...&projectId=...&cursor=...
```

Pomenovanie `conversations` oddeľuje produkt od natívnych runtime sessions. Stará API sa dočasne obalí compatibility vrstvou; frontend nemusí migrovať naraz.

## 7. Doručenie správ, udalosti a obnova

### 7.1 Bežný send

1. Klient vytvorí `crypto.randomUUID()` ako `clientCommandId`, zmrazí vstup a model selection a zobrazí optimistickú user message.
2. Pending vstup uloží lokálne; nová práca v editore dostane novú draft revision.
3. Server validuje workspace, runtime, model a pripravenosť príloh.
4. V jednej DB transakcii uloží command, turn, input refs a event `command.accepted`.
5. Vráti 202 s durable command ID. Žiadne čakanie na štart modelu alebo prvý token.
6. Scheduler pridelí conversation/workspace lease a odošle command runtime.
7. Adaptér preloží udalosti na Run/Message/Interaction/Usage eventy, uloží ich a publikuje.
8. UI prepojí optimistickú správu so serverovou podľa command ID, nevytvorí druhú kópiu.

Ak sa stratí HTTP odpoveď, klient opakuje **ten istý** command ID alebo sa opýta na jeho stav. Rovnaké ID s iným payload hash dostane 409. Rozsah unique constraintu zahŕňa vlastníka a konverzáciu.

### 7.2 Čo garantujeme a čo nie

- Workbench garantuje idempotentné prijatie príkazu a jednu položku fronty.
- Event doručovanie je at-least-once; klient deduplikuje podľa sequence/entity version.
- Nemožno všeobecne garantovať exactly-once externú tool akciu, keď proces spadne medzi vykonaním akcie a uložením výsledku.
- Pri nejasnom runtime submit výsledku použiť `dispatch_uncertain`, dohľadať native message/client ID a zosúladiť stav. Automaticky znova neposielať celý prompt bez dôkazu, že prijatý nebol.
- Ak engine umožňuje klientom pridelený message ID, využiť ho, ale jeho dedup semantiku overiť testom konkrétnej verzie.

### 7.3 Run state machine

```text
queued → starting → running → succeeded
                      ├→ waiting_for_input → running
                      ├→ retry_wait → running
                      ├→ stopping → cancelled
                      └→ failed

starting / running → reconciling → running | interrupted | failed
dispatching → dispatch_uncertain → reconciling
```

Idle konverzácia nemá bežiaci run a nepotrebuje štítok „Ready“. `failed`, `cancelled`, `interrupted` a `succeeded` sú odlišné stavy.

- Jeden aktívny run na konverzáciu, potvrdené transakčným constraintom/lease.
- Lease expiry samo osebe neoprávňuje spustiť druhého writera: fencing token + overenie/zastavenie starej runtime generácie.
- Heartbeat patrí runneru, nie browseru.
- Restart API nevytvorí nové agentické behy; najprv vykoná reconciliation s existujúcim runtime.
- Runtime crash označí rozbehnutú prácu ako interrupted. Pokračovanie vychádza zo skutočne uloženého transcriptu a workspace, nie z automatického opakovania tool akcií.

### 7.4 SSE a reconnect

- Jeden autentifikovaný multiplexovaný stream na klienta s conversation/project referenciami. Pri väčšom počte tabov možno použiť BroadcastChannel/SharedWorker; na začiatku postačuje stream na tab.
- `id: <seq>`, verzované event payloady, `Last-Event-ID`/`after`, heartbeat približne 15–25 s, retry s jitterom.
- Eventy najprv uložiť, až potom publikovať. Textové delty možno zlúčiť do 50–100 ms dávok; jednotlivé tokeny nepotrebujú DB transakciu.
- Dávka je hranica durability. UI nesmie dostať replay ID pre ešte neuložené dáta.
- Bootstrap vráti snapshot s `snapshotSeq`; následne replay od tohto bodu. Pri reconnecte klient aplikuje iba novšie eventy.
- Retention eventov napríklad 7 dní/konfigurovateľný počet. Starší cursor dostane explicitný `resync_required`, nie tichú dieru.
- Natívny OpenCode/Pi stream automaticky nemusí mať replay. Pri strate runtime spojenia: subscribe/buffer, fetch snapshot, idempotentne zosúladiť cez native IDs a verzie, zopakovať snapshot ak nie je istá konzistencia. Nespoliehať sa na samotné opätovné otvorenie SSE.
- Pomalý klient má limitovaný buffer; pri prekročení ho odpojiť s možnosťou replay. Nesmie blokovať agentický beh.
- Pri nedostupnom SSE použiť dočasný backoff polling cez **ten istý seq cursor**, nie dnešný last-20 endpoint.
- Otestovať stream cez reálny Worker/VPC/Tunnel chain, buffering, idle disconnect a auth expiry. Worker len preposiela `response.body`.

## 8. Agentické UX bez terminálového balastu

### 8.1 Základný screen

```text
Sidebar                         Conversation
├─ New conversation             [Project / workspace]   [Model ▾] [Usage]
├─ Search
├─ Projects                     User message
│  ├─ Workbench                 Krátka správa agenta, ak má informačnú hodnotu
│  ├─ RiftSense                 ▸ Upravené 3 súbory · 8 kontrol
│  └─ AutoOffer                 Výsledok + dôležité odkazy
├─ General
├─ Context library              [Attachments / selected context]
└─ Usage & models               [Composer                     Send / Stop]
```

Zachovať Whirl typography, spacing, composer, light/dark režim a decentné komponenty. Projektový switcher musí byť dostupný aj na mobile.

### 8.2 Odstrániť a zjednodušiť

- Odstrániť OutputDialog, live terminal tlačidlá, menu akcie a ich polling.
- Zjednotiť Live a saved sessions v navigácii; aktivitu zobraziť priamo pri konverzácii.
- Žiadny trvalý `Ready to continue`, `Online` alebo `Saved history` pill pre normálny chat.
- Engine picker presunúť do advanced/settings; najbežnejšia voľba je model, nie CLI.
- Úspešný send netoastovať. Je viditeľný v threade. Toasty ponechať na vedľajšie operácie a chyby.
- Ask panel zlúčiť do workflow tej istej konverzácie: vysvetliť výsledok alebo prejsť do skutočne read-only režimu. Ak zostane, musí mať samostatne účtované usage a jasne obmedzený kontext.

### 8.3 Čo má byť viditeľné počas práce

„Bez live output“ znamená bez streamovania terminálu. UI stále dostáva priebeh, text odpovede a interakcie:

- jeden nenápadný stav pri aktuálnom turne: „Analyzujem“, „Upravujem súbory“, „Spúšťam testy“;
- zbalený súhrn aktivít, nerozbaliť automaticky každý tool;
- otázka/permission ako inline karta s reálnymi možnosťami a reply action;
- počty zmenených súborov, výsledky testov a dokončenie;
- podrobné diagnostické logy až na vyžiadanie v detaile runu;
- podporovať aj variant, v ktorom sa text odpovede zobrazí po blokoch alebo až po dokončení; transport udalostí zostáva rovnaký.

Poradie parts musí zostať chronologické. Súčasné „všetok text a potom všetky tools“ môže prehodiť význam jednotlivých krokov.

### 8.4 Composer počas behu

Predvolená akcia: **pridať správu do trvalej fronty za aktuálny turn**. Vedľajšia voľba „Upraviť zadanie teraz“ použije steering len tam, kde ho runtime podporuje.

- Fronta sa zobrazuje ako malé editovateľné položky so zvoleným modelom.
- Stop zastaví aktívny run a pozastaví zostávajúcu frontu. Používateľ potom vedome obnoví odosielanie.
- Ak používateľ zvolí „zastaviť a nahradiť zadaním“, najprv potvrdiť settled/terminated stav a až potom začať nový turn.
- Queued input možno odstrániť alebo upraviť pred dispatchom; úprava zvýši revision.
- Server rozhodne, či sa input prijal do fronty, aj keď mal klient zastaraný stav.
- Zmena chatu nikdy nepresunie draft do inej konverzácie; draft je naviazaný na stabilné conversation ID, nie pane ID.

### 8.5 Výsledok práce, nie len dlhá odpoveď

Produkčný agentický thread potrebuje:

- **Changes:** diff oproti baseline konkrétneho runu, zmenené súbory, prehľad testov.
- **Tasks:** stručný plán/checklist, ak ho agent skutočne používa; nie povinný plán pre triviálnu otázku.
- **Interactions:** otázky a approvals bez otvorenia terminálu.
- **Artifacts:** dokument, screenshot, patch, test report ako samostatné objekty.
- **Child runs:** subagenti vnorení pod rodičom; ich tokens a stav sa dajú rozbaliť, nezahlcujú sidebar.
- **Fork:** pokračovanie od správy s jasným vysvetlením kontextu a workspace.

Undo súborov nie je to isté ako vrátenie chatu. Prípadný revert kontroluje aktuálne hash/dirty stav a nesmie prepísať novšie používateľské úpravy.

## 9. Univerzálny model picker

### 9.1 Oddeliť štyri pojmy

```text
Engine:      OpenCode / Pi / prípadne Codex alebo Claude
Provider:    OpenAI / OpenCode Go / Anthropic / kompatibilný endpoint
Connection:  konkrétny účet alebo API key + auth method + billing/plan
Model:       konkrétna ponuka dostupná cez connection a engine
```

`provider/model` nestačí. Dva účty môžu ponúkať rovnaký model s inou cenou, limitom a oprávneniami. OpenAI OAuth/ChatGPT plan a OpenAI API billing sa nesmú zameniť.

Ponuka nesie:

```text
selectionId, connectionId, providerId, modelId, displayName
engineCompatibility, apiProtocol
supportsTools, supportsImages, supportedReasoningLevels
contextLimit, outputLimit, availability, availabilityReason
pricingVersion, pricingSource, billingMode
catalogFetchedAt, favorites/recent
```

Chýbajúca capability je unknown, nie automaticky true. Catalog modelov sa zlučuje s reálne connected providers; samotný verejný zoznam modelov neznamená prístup účtu.

### 9.2 Picker UX

- Rovnaký komponent na novom chate aj v otvorenej konverzácii.
- Zatvorený chip: čitateľný model + diskrétne označenie pripojenia.
- Po otvorení: search, favorites, recent, potom modely z pripojených účtov.
- Primárne zobrazovať dostupné modely; nedostupné až cez „Show unavailable“ s dôvodom.
- Riadok: názov, connection alias, relevantné schopnosti, context limit, cenu alebo „Plan“.
- Rozlišovať identické názvy od rôznych providerov; raw model ID dať do detailu, nie ako hlavný label.
- Reasoning effort ako samostatná voľba iba pri podporovaných hodnotách. Nevynucovať rovnakú škálu pri všetkých provider protokoloch.
- Úplná keyboard navigácia, typeahead, accessible combobox/listbox, mobile sheet.
- Žiadne svojvoľné `.slice(0,100)` bez ďalšieho stránkovania. Veľký catalog virtualizovať.
- Správa pripojení, login, refresh, odpojenie a provider health sú v `Usage & models`.

### 9.3 Zmena modelu počas session

1. V idle stave zmena platí pre ďalšiu správu v tom istom chate.
2. Počas behu zostáva aktívny run na svojom immutable modeli; chip ukáže „Next: …“. Aktuálny model je viditeľný pri rune.
3. Už queued turny nesú model selection zachytený pri prijatí. Ich model možno explicitne zmeniť, kým nezačali. Zmena defaultu ich potichu neprepíše.
4. Každý dispatch posiela resolved model explicitne. Žiadne spoliehanie sa na globálny CLI default.
5. Settings majú revision/ETag; súbežná zmena z dvoch zariadení sa neprepíše bez kontroly.
6. Pri novom modeli overiť multimodalitu, tools, context budget a kompatibilitu histórie.
7. Pri menšom context limite: preflight, rezervovať output/system/tools, podľa potreby kompaktovať natívnym runtime mechanizmom a zaznamenať checkpoint. Neorezávať náhodne posledných N znakov.
8. Pri zmene provideru môže zaniknúť prompt cache a môže sa zmeniť serializácia tool/response blokov. História v UI zostáva úplná; modelový kontext pripravuje adaptér.
9. Engine switch je explicitný „Continue with another engine“ handoff s novým natívnym session ID a referenciou na pôvodný chat. Nie automatický následok kliknutia na model.

### 9.4 Defaulty

Poradie výberu:

```text
explicitný model queued turnu
  → override konverzácie
  → default projektu
  → používateľský default
  → ponúknuť dostupný model, ak nič nevyhovuje
```

Picker akcie: „Použiť v tomto chate“, „Predvolené pre projekt“, „Moje predvolené“. Predvoľby sa ukladajú na server a synchronizujú medzi zariadeniami. Nový default nemení minulé runy ani už prijaté turny. Nedostupný default zobrazí dôvod a výber náhrady; nemení sa potichu na platenú inú connection.

## 10. Usage, cena a limity plánu

### 10.1 Tri rozdielne ukazovatele

1. **Kontext:** koľko kontextu spotrebuje aktuálny/posledný model request voči efektívnemu limitu. Nie súčet všetkých historických input tokenov.
2. **Spotreba:** input/output/cache/reasoning tokens a náklady konkrétnych requestov/runov.
3. **Kvóta účtu/plánu:** zostávajúca kapacita providera a čas resetu, ak ju provider vie autoritatívne reportovať.

Tieto hodnoty sa nesmú zlúčiť do jedného percenta.

### 10.2 Obrazovka Usage & models

Sekcie:

- **Overview:** dnes / 7 dní / aktuálny mesiac / vlastný interval; tokens, requesty, completed/failed runs, odhad API cost.
- **Connections:** stav účtu, auth metóda, provider quota windows, reset, posledná aktualizácia, odkaz na provider console.
- **Breakdown:** project → conversation → run → model request; filter model/provider/engine.
- **Models:** dostupné ponuky, favorites, defaulty a capability detail.

V threade nenápadný usage detail pri turne. V pickeri iba relevantný stručný stav; celá finančná tabuľka nepatrí do malého popoveru.

### 10.3 Dostupnosť dát

| Zdroj | Čo vieme | Čo nemožno predpokladať |
|---|---|---|
| Runtime usage events | Tokens a prípadný native cost pre konkrétne kroky | Že zachytia fakturáciu mimo Workbench |
| OpenCode Go | Zdokumentované coding endpoints, modelové sadzby/plan okná, usage v console | V otvorenej dokumentácii nebolo potvrdené stabilné verejné quota API použiteľné týmto kľúčom |
| OpenAI API key | Request usage a pricing; účet môže mať samostatné billing/administrative rozhrania | Že bežný inference key poskytne celé billing/organization usage |
| OpenAI OAuth cez OpenCode | Použitý auth typ a runtime request usage | Že všeobecný OpenCode provider endpoint vráti zostávajúci ChatGPT plan |
| Codex app-server | Dokumentuje `account/rateLimits/read` a `account/rateLimits/updated` pre ChatGPT | Že toto API existuje aj v aktuálnom OpenCode adapteri alebo Pi |

Pre Go quota integráciu najprv overiť podporovaný endpoint alebo hlavičky s jeho dokumentovanou semantikou. Ak chýba, UI ukáže **lokálne zaznamenanú spotrebu**, „Kvóta poskytovateľa nedostupná“ a console link. Žiadne scrapovanie dashboardu ako kritická produkčná závislosť a žiadne vymyslené „ostáva 80 %“.

`0`, `null/unknown`, `stale` a `not_supported` sú rozdielne hodnoty. Každá metrika nesie `source`, `observedAt`, `scope` a `confidence: reported/estimated`.

### 10.4 Usage ledger

- Záznam na **jeden unikátny model request/step/attempt**, nie na každý tokenový event ani každé opakované snapshot načítanie.
- Unique identity z native request/step IDs + runtime binding generation. Cumulative a delta usage majú odlišnú normalizáciu.
- Do účtovania zahrnúť title/tag generation, Ask, compaction a subagents.
- Zahrnúť aj billed usage neúspešných/cancelled requestov, ak ho provider dodá.
- Pri crashi pred finálnym usage označiť incomplete/unknown, nie nulový cost.
- Cache-read/write tokeny normalizovať podľa providera. Niektoré protokoly ich reportujú ako podmnožinu input, iné oddelene; univerzálne sčítanie by spôsobilo double counting.
- Pricing snapshot obsahuje čas platnosti, model/connection, context tier, prípadný peak/off-peak faktor a menu. Aktuálna cena neprepočítava historické náklady.
- Pri subscription pláne oddeľovať **ekvivalentnú hodnotu usage** od peňazí na faktúre. Go „allowance consumption“ nie je automaticky ďalšia platba.
- Celkové root conversation usage sa počíta z requestov vrátane detí práve raz, nie zo súčtu parent kumulácie a child kumulácie.
- Import starých dát označiť ako imported/runtime-reported/coverage-limited. Netvrdiť presnosť faktúry spätne.

Go dokumentuje viacero API tvarov podľa modelu: OpenAI completions, Responses aj Anthropic messages. Univerzálny provider adapter preto nie je jeden hardcoded `openai-compatible` endpoint. Pri priamych Go volaniach zachovať stabilný `x-opencode-session` a vlastnú klientsku identifikáciu.

## 11. Projekty podľa priečinkov a skutočného pracovného kontextu

### 11.1 Registry a identita

- Projekt má stabilný UUID, názov a canonical root. Zobrazený názov nie je identifikátor.
- Cestu riešiť cez `realpath`, file-system boundary checks a existenciu, nie len cez string prefix.
- Pri cwd pod projektom vybrať najbližší registrovaný ancestor root, na hranici path segmentu. `app` nesmie matchnúť `app-old`.
- Explicitne registrovaný nested projekt má prednosť pred rodičom.
- Worktree má vlastný Workspace, ale spoločný Project. Pomáha Git common directory; samotný remote URL nie je dostatočná identita dvoch checkoutov.
- Podporovať registrované priečinky mimo `~/projects` v rámci nakonfigurovaných povolených roots.
- Chýbajúci/presunutý root dostane stav missing a akciu „Reconnect folder“. História zostáva čitateľná.
- Priradenie projektu je deterministické a viditeľné; LLM môže navrhnúť opravu, nie potichu meniť vykonávacie cwd.

### 11.2 General verzus projektový chat

`General` je explicitne `projectId=null`, nie synonymum pre celý `~`.

- Všeobecný chat má neutrálny workspace a primerané nástroje, bez automatického načítania projektových inštrukcií.
- Ak používateľ potrebuje pracovať s repozitárom, pripojí konkrétny projekt.
- Administrácia celého VPS môže mať samostatný explicitný „VPS workspace“, nie byť implicitným general defaultom.
- Scope v UI určuje organizáciu a kontext; skutočné OS oprávnenia určuje runner sandbox. Samotné cwd nie je bezpečnostná hranica.

### 11.3 Historické sessions

Pri importe:

1. Top-level sessions s cwd v známom root/worktree priradiť automaticky a uložiť dôvod.
2. Child sessions zdedia logický projekt rodiča; vlastné native cwd zachovať pre audit.
3. HOME/root sessions označiť General alebo Unassigned podľa migračnej politiky; nevymýšľať projekt z poslednej použitej voľby v UI.
4. Ponúknuť hromadné manuálne priradenie, prípadne návrhy podľa referencií na súbory. Návrhy nie sú autoritatívne.
5. **Zmena kategórie chatu nie je zmena execution directory.** Starý chat z HOME možno logicky zaradiť pod Workbench, ale pokračovanie v novom cwd vyžaduje explicitný compatible resume alebo nový native session handoff.
6. Sessions z `AutoOffer-zakladna` a `AutoOffer-windshield` riešiť aj vtedy, ak ich pôvodné priečinky už neexistujú: história zostáva, väzba na nový workspace je explicitná.

### 11.4 Súbežná práca v projekte

- Prvý release: jeden writer na konkrétny workspace; ďalší turn čaká s jasným dôvodom.
- Paralelné editovanie má prebiehať v separátnych worktrees/workspaces.
- Baseline zachytáva aj existujúce necommitnuté používateľské zmeny. Diff sa musí vzťahovať na začiatok runu, nie slepo na HEAD.
- Revert/merge robí conflict detection; neprepisuje cudziu novšiu prácu.
- General chat bez projektových tools môže bežať paralelne s coding runom, ak dovolí globálny memory budget.

## 12. Clipboard → projektová knižnica kontextu

### 12.1 Rozlíšiť tri veci

1. **Systémový clipboard:** jednorazové paste/copy na zariadení.
2. **Príloha správy:** immutable input konkrétneho turnu.
3. **Uložený clip:** znovupoužiteľný kontext, dostupný na viacerých zariadeniach.

Vloženie do editora automaticky neznamená uloženie do knižnice a uloženie clipu automaticky neznamená odoslanie modelu.

### 12.2 Scope a ovládanie

- Scope `General` alebo konkrétny `Project`.
- Pri uložení z projektového chatu default scope = jeho projekt; UI ukáže chip a možnosť zmeniť scope.
- Pri všeobecnom clip view default = aktuálne zvolený filter alebo General.
- Composer `+` ponúkne Upload, Paste, From library, From project files.
- Context picker štandardne zobrazí aktuálny projekt + General, so samostatnou voľbou ostatných projektov.
- Akcie clipu: vložiť text, pripojiť ako kontext, copy, presunúť scope, rename, pin, delete/undo.
- Podporovať text, code snippet s jazykom, URL, screenshot a povolené súbory; pre súbory explicitná extrakcia/preview a limit veľkosti.
- Zobraziť pôvod: zariadenie, conversation, súbor, čas. Full absolute path zobrazovať iba tam, kde je užitočná.

### 12.3 Upload a uchovávanie

- Blob upload mimo JSON promptu; UI používa `URL.createObjectURL` pre náhľad a reference ID po uploade.
- Prompt obsahuje attachment IDs. Rovnaká cesta pre nový aj existujúci chat.
- Overiť MIME podľa obsahu, veľkosť a image dimensions; vytvoriť thumbnail pre UI.
- Deduplikácia hashom v rámci rovnakého vlastníka; upload concurrency napríklad 2, s jasným progress/error/retry.
- Stav `uploading/ready/failed`; accepted command vznikne až keď sú jeho prílohy pripravené alebo server explicitne podporí waiting-for-attachment stav.
- Agent dostane runtime-native image part alebo povolený file reference, nie iba text „obrázok je niekde na VPS“.
- Zmazanie clipu nevymaže obrázok použitý v existujúcej správe. Attachment refs a retention sú samostatné.
- Garbage collection iba pre nereferencované blobs; denné mazanie podľa veku nesmie poškodiť históriu.
- Limits podľa bytes a politiky uloženia, nie iba globálne „100 clips a koniec“.
- Clip create/update/delete event okamžite aktualizuje ďalšie otvorené zariadenie.

Paste má rešpektovať caret/selection, podporovať bežné Ctrl/Cmd+V bez špeciálneho permission flow a pri mixed text+image nestratiť jednu časť. Programatický „Paste“ je doplnok s browser fallbackom.

## 13. Performance a efektivita

### 13.1 Frontend

1. Lazy-load History, Library, Usage, System a ostatné sekundárne panely. Rozdelenie podľa reálnych chunk measurements.
2. Composer state oddeliť od App orchestration; písanie nesmie znovu renderovať celý sidebar a transcript.
3. Transcript store normalizovať podľa message/part ID a version. Deltu aplikovať na príslušný part, nie sortovať celý thread.
4. Zachovať TanStack Query structural sharing pre bežné zoznamy; stream do úzko zameraného store/selectorov. Neprepisovať dobré časti stacku bez merania.
5. Virtualizovať dlhé thready a veľké zoznamy; zvládnuť dynamické výšky Markdown/code/images a prepending bez scroll jumpu.
6. Už dokončené Markdown bloky cache/memo. Pri streamovaní prepočítavať iba otvorený blok; zvýrazňovať veľký code až pri dokončení alebo po otvorení.
7. Uzavreté tool detaily nesťahovať a nemountovať; v threade iba summary/metadáta.
8. Aktualizácie batchovať približne 50–100 ms. Nepotrebujeme animation tick pre každý token.
9. Fetch cancellation na zmenu route; stabilné query keys; rovnaké ID pre optimistic a confirmed položku.
10. Fonty a assety servovať z edge, hashed immutable; HTML revalidovať. Shell musí vedieť ukázať degradovaný runtime aj bez úspešného overview.
11. Cache draftov v IndexedDB s debounce a cleanupom; žiadne veľké base64 obrázky v localStorage alebo root React state.
12. Testovať mobile, touch, klávesnicu, IME, focus management, reduced motion a dlhé kódové bloky.

### 13.2 Backend

- Žiadne CLI/systemctl procesy na request read path.
- Malý bootstrap: projekty, posledné root konverzácie, connection health; nie 300 sessions s preview a system stats naraz.
- Keyset pagination; FTS pre hľadanie; DB indexes pre project/updated/parent/run state/seq.
- Povinný page/event byte budget, nielen počet záznamov.
- Model catalog refresh single-flight na pozadí, cache na disku/DB, last-known-good výsledok aj pri provider výpadku.
- Prijatie turnu a runtime execution oddelené; fronta má obmedzenú kapacitu a per-workspace fairness.
- Uploady streamovať do dočasného súboru s limitom pred presunom, netvoriť niekoľko plných base64/Buffer kópií.
- Eventy zapisovať v malých dávkach, bounded queues pre každé spojenie.
- Veľké importy a pricing aggregates spúšťať mimo latency-critical path.
- Nastaviť limity podľa measured heap/RSS/cgroup peak. Nefixovať 160 MiB len preto, že to stačilo pôvodnej verzii.

### 13.3 Runtime a kontext

- Začať jedným aktívnym coding runom na tomto VPS; druhý povoliť až podľa headroomu a benchmarku. Konverzácií môže byť pritom otvorených mnoho.
- Jeden writer na workspace, globálny runtime memory/CPU limit a rezervovaná kapacita pre API/OS.
- Používať `MemAvailable`, memory pressure a cgroup účtovanie; cgroup limit sa nevzťahuje len na JS heap.
- Zahriaty runtime podľa potreby, idle unload/eviction s perzistenciou; nie jeden navždy živý TUI na chat.
- System diagnostics zbierať serverovo raz, frontend aktualizovať iba keď ich používateľ potrebuje.
- Stabilný system prompt/tool schema a session header pomáhajú cache; neprepisovať prefix kvôli kozmetickým UI údajom.
- Kontext z knižnice iba pri explicitnom pripojení alebo jasných projektových pravidlách. Nevkladať celý clipboard do každého promptu.
- Title generation asynchrónne a najviac raz pre príslušnú revision; pri chybe lokálny title fallback, bez blokovania chatu.
- Compaction kontrolovať podľa reálneho context limitu a output reserve; zachovať pinned requirements a referencie na artifacts.

### 13.4 Merateľné ciele

Nasledujúce hodnoty sú **cieľové rozpočty**, ktoré sa doladia meraním na tomto VPS a typickom klientovi:

| Metrika | Cieľ |
|---|---|
| Lokálny vizuálny feedback po Send | < 50 ms |
| Durable command acceptance na lokálnej API | p95 < 150 ms bez upload času |
| Warm API→runtime dispatch | p95 < 300 ms, samostatne od model TTFT |
| Persisted event→UI | p95 < 250 ms v referenčnom end-to-end teste |
| Cached prepnutie chatu | < 100 ms |
| Initial JS | cieľ ≤ 180 kB gzip; aktuálne ~297 kB gzip |
| Bežná stránka transcriptu | cieľ ≤ 100 kB bez blob payloadov; veľké parts cez lazy artifact |
| Idle aplikácia | žiadny chat polling, iba heartbeat a potrebné health refresh |
| 1 000+ správ | p95 reakcia editora < 50 ms pri scrollovaní/streamovaní |
| API memory | stabilný plateau v 24 h soak teste, bez opakovaného dosahovania cgroup max |
| Doručenie pri fault testoch | 0 stratených accepted commands, 0 duplicitných dispatchov spôsobených retry klienta |

TTFT providera merať osobitne. Zníženie UI overheadu z sekúnd na stovky milisekúnd nezaručuje rovnako rýchle dokončenie komplexnej agentickej úlohy.

## 14. Produkčná prevádzka

### 14.1 Release a dátové úložisko

- Reproducible build cez lockfile a `npm ci`; build v CI/staging, nie cez npm prestart na živej službe.
- Release artifacts sú immutable, runtime dáta mimo repo/release adresára.
- Asset retention: aktuálna a predchádzajúce verzie alebo časové okno pokrývajúce otvorené klienty. Najprv upload assetov, potom atomická výmena indexu.
- Edge shell z `ASSETS.fetch` po auth; API cez privátny binding. Nevytvárať fallback, ktorý mieša HTML jednej verzie s assetmi inej verzie.
- Starý frontend a nový backend majú definované kompatibilitné okno cez API/event schema version.
- SQLite migrácie s verzovaním, foreign keys, WAL, busy timeout a rollback postupom. Vybrať synchronous policy podľa explicitnej durability požiadavky; accepted commands preferujú odolnosť aj voči náhlemu výpadku hosta.
- Online backup cez SQLite backup mechanizmus, nie kopírovanie otvoreného `.db` bez WAL. Spolu s referencovanými blobs a natívnymi runtime checkpointmi.
- Denná záloha, pravidelný restore drill. Návrh cieľa pre privátne nasadenie: RPO ≤ 24 h pri strate celého VPS, RTO ≤ 60 min; lokálny reštart služby nesmie stratiť accepted frontu. Striktné nulové RPO pri strate hosta vyžaduje replikáciu.

### 14.2 Identity a execution policy

- Zachovať autentifikáciu na edge aj ochranu interného originu; pri rozšírení na viac používateľov zaviesť osobné identity a objektovú autorizáciu.
- Jedna overiteľná session/CSRF politika pre edge aj direct access, session revoke/logout a stream expiry.
- Secret references na serveri; žiadne tokeny v browseri, exportoch alebo procesných argumentoch. OAuth refresh má jedného vlastníka.
- Runner s explicitnými workspace mounts, writable temp a limity procesov/CPU/RAM; oprávnenia API služby nie sú sandbox nástrojov.
- Read-only režim vynútiť výberom tools/OS policy, nielen system promptom.
- Permission/question UI mapovať na skutočné runtime requesty, s timeoutom a idempotentnou odpoveďou. Nepridávať schvaľovanie každej neškodnej akcie.
- API Stop smie zasiahnuť len vlastnený run/cgroup vrátane subprocessov; globálne PID kill nepatrí do bežnej konverzácie.
- Logovať IDs a failure codes, nie plné prompty/credentials. Raw artifacty sú chránené rovnako ako chat.

### 14.3 Observability

Každá operácia nesie `requestId`, `clientCommandId`, `conversationId`, `turnId`, `runId`, `runtimeSessionId` podľa dostupnosti.

Sledovať:

- command accept latency, queue wait, dispatch latency, TTFT, time-to-complete;
- runtime health, unexpected exits, retry/error dôvody;
- SSE connections, lag, reconnect, replay gaps a snapshot repairs;
- DB latency, event loop delay, memory/cgroup pressure, upload bytes;
- usage coverage, neznáme cost records a starnúce quota snapshots;
- failed title jobs oddelene od coding runov.

Worker logs a traces nastaviť explicitne so samplingom. Health/readiness majú rozlíšiť API/DB/runtime dostupnosť; nevyžadovať zdravý runtime na čítanie histórie.

Súčasná VPC Service integrácia je podľa overenej Cloudflare dokumentácie beta. Zachovať ju pre pilot, ale stream/reconnect a prevádzkový fallback overiť pred deklaráciou SLA. Dlhý run vždy žije na runneri, nie v lifecycle edge HTTP requestu.

## 15. Migračný plán

### Fáza 0 — baseline a ochrana rozpracovaného stavu

**Výstup:** reprodukovateľný snapshot a staging prostredie.

- Zaznamenať aktuálne rozpracované súbory a build hash, bez prepísania používateľských zmien.
- Záloha natívnych sessions, Workbench JSON dát a príloh.
- Doplniť telemetry body na dnešný send flow a zmerať referenčné scenáre.
- Izolovaný staging runtime/dátový adresár; žiadny druhý writer do živého projektu.
- Overiť API/SDK kontrakt OpenCode `1.18.34` a spôsob zachovania existujúceho OAuth pripojenia.

**Gate:** história a dáta sa dajú obnoviť; poznáme baseline; staging nezasahuje do živých behov.

### Fáza 1 — odstrániť straty vstupov a založiť durable control plane

**Výstup:** Workbench DB, jednotné commands, stabilné conversation IDs.

- Opraviť F02–F05: prvé attachments, neisté prijatie, draft revision, durable queue.
- Command idempotency, per-conversation single writer, run stav a failure dôvody.
- Import metadata/preferences/clips do vlastnej DB.
- Oddeliť root a child sessions; opraviť history cursor.
- Založiť event log aj keď časť legacy histórie ešte používa starý importer.

**Gate:** reload, dva taby a lost HTTP response nestratia accepted správu ani nevytvoria druhý command.

### Fáza 2 — OpenCode headless vertical slice

**Výstup:** nový chat → prvý prompt → tools → výsledok → ďalší prompt → stop, kompletne bez Herdr.

- OpenCode adaptér, runtime supervisor, explicitné mapping IDs.
- Zmena modelu medzi turnmi, native attachments, otázky/permissions.
- SSE do frontend store, replay a runtime snapshot reconciliation.
- Čitateľná história funguje aj pri runtime outage.
- Nové sessions defaultne cez headless; legacy aktívne TUI behy sa dokončia pôvodnou cestou.

**Gate:** žiadny nový Workbench chat nepoužíva klávesové TUI ovládanie ani nový `opencode run` pre pokračovanie.

### Fáza 3 — produktové UI a model/usage vrstva

**Výstup:** jeden konzistentný chat a plnohodnotný picker.

- Odstrániť live output a ready pills.
- Jednotný composer, queued input, inline interactions, výsledky/changes.
- Model offerings, connection health, favorites, default hierarchy a next-model semantics.
- Usage ledger pre všetky modelové volania, projektové agregáty a oddelené quota snapshots.
- Otázky na výsledok riešiť v konverzácii alebo jasnom read-only mode.

**Gate:** model zvolený v UI zodpovedá dispatchu; staré runy ukazujú skutočný model; neznáma quota nikdy nevyzerá ako nula alebo presný odhad.

### Fáza 4 — projekty a context library

**Výstup:** správny project/workspace scope naprieč navigáciou, chatom a prílohami.

- Project registry, root/subdirectory/worktree resolver, General a missing-folder flow.
- Import/reassignment historických chatov s oddelením logickej kategórie od cwd.
- Scoped clips, attachment upload service, From library v composeri, cross-device sync.
- File references a explicitný context inspector pre to, čo sa pošle agentovi.

**Gate:** projektové clipy sa nepripoja do nesúvisiaceho chatu; symlinky/worktrees/subfolders majú deterministické mapovanie.

### Fáza 5 — výkon a produkčná odolnosť

**Výstup:** splnené latency a recovery budgety.

- Lazy chunks, transcript virtualization, lazy tool artifacts, render profiling.
- Edge static delivery a bezvýpadková retencia assetov.
- Fault injection, 24 h soak, memory budgets a scheduler.
- Backup/restore drill, migrations/rollback, health a dashboard.
- Canary rollout cez nové conversations, potom riadená migrácia starých neaktívnych sessions.

**Gate:** prešli release-critical scenáre a reálne end-to-end merania cez verejnú URL.

### Fáza 6 — Pi pilot a ďalšie schopnosti

**Výstup:** druhý adapter s tou istou používateľskou skúsenosťou.

- Pi SDK runner, auth onboarding, context persistence, model selection, usage normalization.
- Rovnaký adapter contract suite ako OpenCode.
- Bake-off podľa kapitoly 4.4; až potom rozhodnúť o defaulte.
- Následne podľa potreby worktree parallelism, explicitné engine handoff, Codex/Claude adapter.

### Realistický odhad

Pre jedného skúseného full-stack implementátora: baseline/contract spike približne 2–4 dni, durable core + headless vertical slice 6–10 dní, UI/model/usage 4–7 dní, projects/library 4–6 dní, performance/hardening 5–8 dní. Časti sa prekrývajú; orientačne **4–7 týždňov sústredenej práce** pre spoľahlivú privátnu produkčnú verziu. Pi pilot typicky ďalšie 3–5 dní plus zistené integračné rozdiely. Nie je to záväzný termín bez dokončenia runtime spike.

### Rollback bez dvojitého vykonávania

- Každá conversation má explicitnú integračnú verziu; nikdy dva aktívne adaptéry na jednu native session.
- Legacy/import mapping je unique podľa engine + instance + native session ID.
- Import je opakovateľný s watermarkom a kontrolou počtov/refs; aktívne sessions sa neprenášajú uprostred tool akcie.
- Feature flags podľa conversation/workspace, nie iba globálne pre celý frontend.
- Rollback UI/backendu zachová DB a accepted queue. Ak stará verzia nevie nový command formát, frontu pozastaví; neprehrá ju cez starý CLI flow.
- Staré dáta a kompatibilný viewer zostávajú, kým neprejde overenie migrácie.

## 16. Konkrétny implementačný backlog

| Priorita | Balík | Závislosť | Hotovo, keď |
|---|---|---|---|
| P0 | DB migrations + domain IDs | baseline | transakčné commands/events/metadata a restore fixture |
| P0 | Command admission + idempotency | DB | duplicate/lost-ACK test nevytvorí druhý dispatch |
| P0 | Unified attachment contract | upload store | screenshot funguje aj v prvom prompte |
| P0 | Draft/outbox recovery | command API | reload nevymaže draft ani accepted frontu |
| P0 | Runtime conformance spike | staging | pinované API/SDK + auth + session mapping overené |
| P0 | OpenCode headless adapter | spike/commands | prvý aj ďalší turn, stop, errors bez TUI |
| P0 | Reconciler + event replay | adapter/events | restart API/runner sa zobrazí pravdivo |
| P1 | Frontend event store | event API | žiadne diery, duplicitné správy, scroll regressions |
| P1 | Model connections/catalog | adapter | picker obsahuje použiteľné ponuky s capabilities |
| P1 | Defaults + switch semantics | catalog | aktívny a next model sa nezamieňajú |
| P1 | Usage ledger/UI | normalized events | dedup/price provenance/unknown coverage overené |
| P1 | Project/workspace registry | DB | nested/worktree/moved-folder scenáre prejdú |
| P1 | Context library | projects/uploads | scope + attach + cross-device sync |
| P1 | Inline interactions + result cards | adapter/store | blocked run sa dá vyriešiť iba z UI |
| P1 | Edge assets + release retention | build pipeline | otvorený starý klient prežije deploy |
| P1 | E2E/fault/soak gates | vertical slice | všetky kritické workflow scenáre zelené |
| P2 | Pi adapter | rovnaké contract tests | prínos preukázaný bake-offom |
| P2 | Parallel worktrees / fork / engine handoff | execution baseline | bez konfliktu autority a prepísania súborov |

Navrhované rozdelenie kódu bez vynucovania veľkého monorepa:

```text
server/
  api/                 # routes + auth + schema validation
  domain/              # conversations, commands, runs, settings
  db/                  # migrations, repositories, projection/FTS
  events/              # persistence, SSE, replay
  runtime/             # supervisor, reconciliation, scheduler
    opencode/
    pi/
  models/              # connections, catalog, resolution
  usage/               # normalization, pricing, aggregation
  projects/            # registry, workspace resolver
  context/             # clips, attachments, artifacts
src/
  app/                 # shell + route boundaries
  features/chat/
  features/models/
  features/usage/
  features/projects/
  features/context/
  components/whirl/    # zachované vizuálne primitives
shared/                # versioned contracts; žiadne secrets/runtime internals
tests/
  contracts/
  integration/
  e2e/
```

## 17. Testy, ktoré naozaj rozhodujú o release

### Kontrakty a integrácia

- Prvý prompt aj follow-up používajú rovnaké text/image/file vstupy.
- Dvojklik, client retry a lost ACK vytvoria jeden accepted command.
- Rovnaký command ID s iným payloadom sa odmietne.
- Dva taby neštartujú dve práce v jednej conversation/workspace.
- Queue nepreskočí prvú správu a potichu nič nevyhodí pri limite.
- Stop pozastaví queue a ukončí správny run vrátane subprocessov.
- Event duplicate/out-of-order/gap opraví store bez zdvojenia obsahu.
- Pri >20 nových messages počas offline okna nevznikne diera v threade.
- Runtime event disconnect obnoví snapshot bez odhadu podľa title/cwd.
- Backend crash po DB commit, pred dispatch; po dispatch, pred potvrdením; počas tool call; po completion pred usage projekciou.
- Pi `agent_end` verzus `agent_settled`, compaction/retry a queues, keď sa Pi pridá.
- Model zmena počas aktívneho runu neprepíše jeho attributed model/cost.
- Read-only mode sa nedá obísť iba výberom iného modelu.
- Usage replay/cumulative updates/import nezapočítajú rovnaký request dvakrát.

### End-to-end UX

- Na Home vybrať projekt a model, priložiť screenshot, odoslať, okamžite vidieť vstup.
- Počas pomalého sendu písať nový draft: nesmie sa vymazať po ACK.
- Zmeniť model, poslať ďalšiu správu a overiť skutočný native model request.
- Pridať queued follow-up, zavrieť browser, otvoriť na druhom zariadení.
- Odpovedať na question/permission kartu bez terminálu.
- Scroll hore počas streamovania, načítať staršie správy, vrátiť sa na spodok bez skokov.
- 1 167+ message fixture s code blocks/images/tools zostáva použiteľná.
- Scope General/Project/subdirectory/worktree/missing folder a manuálne historické priradenie.
- Uložiť clip na mobile, vložiť ho do správneho chatu na desktope; zmazanie clipu nepoškodí starú správu.
- Vyhľadanie premenovaného chatu a textu zo staršej správy.
- Deploy novej verzie počas otvoreného starého klienta.
- Prerušenie siete, expirácia login session a opätovné prihlásenie bez straty draftu.

### Prevádzka

- 24 h soak s dlhými transcriptmi a reconnectmi, merať plateau pamäte.
- Large/parallel uploads pri stanovených limitoch nezablokujú health ani send acceptance.
- Runtime outage neblokuje históriu, library ani settings.
- Restore zo zálohy obnoví DB, blob referencie aj natívne kontexty.
- Frontend performance profil na referenčnom mobile a desktop zariadení, nielen na localhost serveri.

## 18. Čo nerobiť ako prvý krok

- Nevymeniť len `opencode` za `pi` v Herdr príkaze. Zachovalo by to hlavné nedostatky.
- Nevytvárať kompletný vlastný coding harness od nuly, kým existujúci serverový runtime vyrieši väčšinu problému.
- Nepridávať ďalší polling a heuristiky na detekciu „už asi pracuje“.
- Nezamieňať počet otvorených chatov s počtom živých agent procesov.
- Neprerábať celý dizajn ani framework. Whirl + React + Vite sú použiteľný základ.
- Nepoužívať React Query ani AI SDK chat hook ako náhradu durable run/command modelu. Sú to UI/transport nástroje.
- Nevyhlasovať Pi za rýchlejší bez merania rovnakých úloh.
- Nevydávať lokálny tokenový odhad za presnú billing alebo plan quota metriku.

## 19. Zdroje a verzie

Overené počas auditu 2026-10-05:

1. [OpenCode Server](https://opencode.ai/docs/server/) — headless HTTP API, sessions, events, provider/model control.
2. [OpenCode SDK](https://opencode.ai/docs/sdk/) — typovaný klient a existujúci server.
3. [OpenCode Go](https://opencode.ai/docs/go/) — billing/usage princípy, viacero protokolov, session header a klientská identifikácia.
4. [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md) — doplnené lokálnou dokumentáciou nainštalovanej verzie `0.87.1`.
5. [Pi RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md), [commands](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-commands.md) — queue/steer/model/settled kontrakty.
6. Lokálne Pi `docs/security.md` a `pi-ai/dist/providers/opencode-go.js`, `opencode-headers.js` — skutočné možnosti inštalácie a hranice izolácie.
7. [Codex app-server](https://developers.openai.com/codex/app-server/) — thread/turn/item, rich-client API, model discovery a account rate limits.
8. [Claude Agent SDK overview](https://platform.claude.com/docs/en/agent-sdk/overview) — programovateľný Claude Code loop a autentifikácia.
9. [Cloudflare Static Assets routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/) — auth pred `ASSETS.fetch`.
10. [Workers VPC API](https://developers.cloudflare.com/workers-vpc/api/) a [limits/status](https://developers.cloudflare.com/workers-vpc/platform/limits/) — existujúci privátny transport a jeho beta status.

**Konečný smer:** zachovať dobrý vizuál, nahradiť terminálovú orchestrace trvalým command/event modelom, vybudovať pravdivé model/usage abstractions a dať projektom stabilnú identitu. Toto prinesie väčšie zlepšenie spoľahlivosti aj pocitu rýchlosti než kozmetické ladenie súčasného chatu.
