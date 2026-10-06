# Workbench v3 — hĺbkový plán prestavby

**Dátum:** 6. október 2026
**Projekt:** `~/projects/Workbench`
**Cieľ:** jeden vlastný, rýchly a spoľahlivý agentický konzument namiesto dvoch polovičných svetov. Žiadne TUI, žiadne CLI obrazovky, žiadny live output. UI zostáva Whirl.

Tento dokument je delta k `WORKBENCH-PRODUCTION-PLAN.sk.md` (audit z 5. 10. 2026). Veľká časť cieľovej architektúry je medzitým **už postavená** — tento plán hovorí, čo s tým: dokončiť migráciu, odstrániť legacy a dotiahnuť produktóvú vrstvu (model/usage, projekty/kontext, agentický result UX).

---

## 0. TL;DR

1. **Základ v2 je funkčný a overený.** `server/control.mjs` + SQLite + OpenCode headless + Pi SDK runner + SSE + usage ledger + clips. Smoke a workflow testy prechádzajú na oboch engine-och.
2. **Preto chaty „nefungujú dobre“: v3 sa nikdy nenasadila.** `public/index.html` servíruje starý legacy build (`index-COeoq26I.js` = App.tsx s „Ready to continue“ a live outputom). Gateway proxuje `/api/v2` na port 8788, ale control beží na 8789 v `/tmp/opencode/workbench-control-staging`. Nové UI sa teda vôbec nenačíta.
3. **Existujú dva produkty v jednom repe:** legacy Herdr/TUI cesta (`server.js` + `App.tsx` + `ai.mjs` + `OutputDialog`) a nová durable cesta (`control.mjs` + `workbench-app.tsx`). Legacy treba zmazať, nie opravovať.
4. **Scheduler je stále „jeden globálny beh“.** Počas `waiting` (permission/otázka) alebo dlhého behu je zablokovaná celá fronta. To je presný opak agentického workflow.
5. **Dokončenie behu sa zisťuje pollingom** (800 ms status + 3 s snapshot), hoci natívne eventy už tečú. Event-driven dokončenie zníži latenciu a CPU.
6. **Model picker je 45-riadkový popover** bez usage, bez connections/plánov, bez hierarchie defaultov. Usage view je statická tabuľka. Toto je hlavná produktová diera a hlavná požiadavka.
7. **Kontakty na projekty a clips existujú v DB**, ale UI defaulty a práca s kontextom nie sú dotiahnuté. Scope sa má odvodzovať z priečinka/konverzácie, nie z posledného filtra.
8. **Legacy kód musí z buildu preč.** Starý entry bundle má ~1,0 MB raw / ~297 kB gzip; nový ~0,41 MB raw. Cieľ po očistení: ≤180 kB gzip initial JS.
9. **Nasadenie:** samostatná `workbench-control.service` (nie transient systemd-run), dátový adresár mimo `/tmp` a mimo repa, gateway len auth + proxy, assety z edge.
10. **Realistický odhad:** F0 stabilizácia 0,5–1 deň; plná v3 ~3–4 týždne sústredenej práce jedného človeka.

---

## 1. Aktuálny stav (overený 6. 10. 2026)

### 1.1 Čo už reálne existuje a je dobré

| Vrstva | Súbor | Stav |
|---|---|---|
| Durable store (SQLite WAL) | `server/store.mjs` | conversations, commands, messages, events, usage, clips, attachments, interactions, artifacts, FTS |
| Command admission + idempotencia | `server/store.mjs:132` | `clientCommandId` + payload hash, per-conversation single-writer index |
| OpenCode headless runtime | `server/runtimes.mjs:11` | `opencode serve --pure`, session binding, prompt_async, event stream + snapshot reconciliation, abort |
| Pi runtime (SDK, nie CLI) | `server/runtimes.mjs:114`, `server/pi-runner.mjs` | `createAgentSession`, `SessionManager`, fork/child proces, usage z `message.usage` |
| Control API v2 | `server/control.mjs:214` | bootstrap, models, connections, conversations, commands, interactions, attachments, artifacts, clips, usage, events (SSE) |
| Scheduler | `server/control.mjs:150` | `tick()` – jeden aktívny beh, fronta, pauza, memory admission |
| Nové UI | `src/workbench-app.tsx` | Home/chat/history/clips/usage, SSE, IndexedDB drafty a pending intenty, optimistic user message |
| Model picker | `src/components/whirl/universal-model-picker.tsx` | search + favorites + „set default“ (základ) |
| Usage | `src/components/whirl/pages/usage-view.tsx` | súčty, by model, by project, connections, OAuth start/complete |
| Context library | `src/components/whirl/pages/context-library.tsx` | scoped clips (project/general/all), upload, pin, move |
| Thread | `src/components/whirl/thread/*` | virtualizovaný transcript, tool activity, inline interaction karty, per-message tokens |
| Edge | `worker.js` | login, session cookie, rate limit, proxy, ASSETS fallback |

### 1.2 Deployment realita — koreň problému s chatmi

- `workbench-console.service` beží `server.js` na 8787, `MemoryMax=160M`, `WORKBENCH_DATA=<repo>/data`.
- `workbench-control-staging.service` (transient systemd-run) beží `control.mjs` na **8789**, dáta v **`/tmp/opencode/workbench-control-staging`**, opencode serve na 4199, `MemoryMax=1.2G`.
- `server.js:1237` proxuje `/api/v2/*` na `WORKBENCH_CONTROL_PORT || 8788`. **Na 8788 nič nepočúva.**
- `public/index.html` referencuje `index-COeoq26I.js` (legacy build s „Ready to continue“, live outputom). Nový build (`index-Bt4GJmmY.js`, `thread-view-*.js`, `usage-view-*.js`) leží v `public/assets` od 12:15, ale nebol promovaný.
- Dôsledok: používateľ dostane staré UI, ktoré ide cez Herdr TUI a v2 API vôbec nepoužíva. Presne to vysvetľuje „chaty nefungujú dobre“.

### 1.3 Čo je overené testami (nie dohad)

- `npm run check` prechádza (node --check všetkých server súborov + `tsc --noEmit`).
- `scripts/workbench.smoke.mjs`: oba engine-y (opencode aj pi), idempotentné prijatie príkazu, odpoveď v transkripte, usage, scoped clips.
- `scripts/workbench.workflow-test.mjs`: prvý attachment, resume kontext, **zmena modelu medzi turnmi** (ďalší request skutočne ide novým modelom), **pauznutá durable fronta + resume**, **SSE eventy bez pollingu**.
- Staging DB má 31 konverzácií, 6417 usage záznamov (import legacy), pi sessions.
- Verzie: Node 22.22.1, OpenCode 1.18.34, Pi 0.87.1 (`@earendil-works/pi-coding-agent` pinned exact).

**Záver:** netreba prerábať jadro. Treba dokončiť nasadenie, zmazať legacy a postaviť na tom produktovú vrstvu.

---

## 2. Diagnóza: prečo to nie je optimalizované na agentic workflow

### 2.1 Dva svety

Jediný commit v gite je „Initial commit“; všetko ostatné je rozrobené. V kóde žijú vedľa seba:

- **Legacy svet:** `server.js` (1769 riadkov) číta OpenCode SQLite na read-only, ovláda Herdr panes cez `agent prompt` klávesy, spúšťa `systemd-run opencode run` pre „saved sessions“, servíruje staré UI `App.tsx` (709 riadkov) + 20 komponentov, `ai.mjs` (Ask panel a title generation).
- **Nový svet:** `control.mjs` (320 riadkov) + `workbench-app.tsx` (191 riadkov) + nové komponenty.

Dokým existujú oba, každá zmena sa robí dvakrát, build nesie mŕtvu váhu a používateľ vidí legacy. Toto je priorita č. 1.

### 2.2 Scheduler blokuje agentické workflow

`server/control.mjs:150` drží jediný globálny `active` slot po celý beh. Beh zahŕňa aj `waiting` na permission/otázku. Následky:

- Počas čakania na používateľa nemôže bežať iná konverzácia.
- Dve otvorené úlohy v rôznych projektoch sa serializujú, hoci VPS má kapacitu (a aj keby nie, čakanie na používateľa nemá blokovať nič).
- `tick()` beží každé 2 s; pri `waiting` sa nič nedeje, len drží slot.

### 2.3 Dokončenie behu je polling

`server/runtimes.mjs:78-99`: `while` slučka každých 800 ms volá `/session/status`, každé 3 s robí full `/session/:id/message?limit=100` snapshot a `/permission` + `/question`. Pritom ten istý run má otvorený `/event` stream (`runtimes.mjs:60`). Je to zbytočná práca naviac a oneskorenie medzi dokončením a UI stavom. Pi runner naopak čaká `session.waitForIdle()` (`pi-runner.mjs:67`) — pri retry/compaction môže vrátiť skôr, než je agent naozaj settled.

### 2.4 Model/usage vrstva je plochá

- Katalóg je `provider/model` string + pár metadát; chýba connection identita, plán (subscription vs API), availability, pricing provenance, updatedAt.
- Conversation má jeden skalárny `model`; default hierarchia (turn → conversation → project → user) existuje len čiastočne v `defaultModel()` (`control.mjs:37`) s hardcoded preferenciou `opencode-go/*flash*`.
- Picker nezobrazuje usage, recent, connection health; nedá sa z neho nastaviť default s vysvetlením „odkiaľ sa model vzal“.
- Usage view nemá časové rady, drilldown na konverzáciu, rozlíšenie reported/estimated/unknown pri každej metrike, ani prepojenie s pickerom (favorites/defaults).
- Title/tags usage sa vôbec nezapisuje; title generation v control chýba (ostala len v legacy `ai.mjs`). Ask panel je mŕtvy legacy a jeho usage nikde nie je.

### 2.5 Projekty a kontext

- `store.projectFor()` a `workspaces` už riešia najbližší ancestor root vrátane git worktrees — dobré.
- Import legacy vytvoril konverzácie s `project_id=null` pre všetko v HOME → General. To je správne, ale chýba UI, ktoré projekt jasne ukazuje a umožní rýchlo presunúť/založiť v správnom priečinku.
- Clips scope existuje (project/general), ale UI defaultuje podľa posledného filtra, nie podľa konverzácie, z ktorej sa klip vytvára.
- V history nie je vidieť priečinok projektu pri položke; pri vytvorení chatu na Home sa projekt volí selectom, ale nové UI nevie „new conversation in this folder“ priamo z priečinka.
- Chýba „From project files“ zdroj a náhľad „čo presne pôjde agentovi“.

### 2.6 UX (Whirl vyzerá dobre, produktová logika nie)

- Ponechané legacy prvky: live output, terminálové ovládanie, „Ready to continue“, „Saved history/Online“ pills, Ask panel.
- Nové UI je jeden 191-riadkový komponent s obrovskými inline JSX blokmi; event handler invaliduje `bootstrap`, `history-v2` a `usage` pri každej udalosti (`workbench-app.tsx:88-91`), takže aj malá zmena stavu behu prefetchuje celý zoznam konverzácií.
- Run nemá produktový „result“: žiadne changes, testy, artifacts, retry. Používateľ vidí text a tool activity.
- Chýba empty-state bez „Ready to continue“ textov a bez zbytočných status pills.

### 2.7 Výkon

- Store: `list()` + `view()` robia N+1 dotazy (60 konverzácií ≈ 240+ dotazov na bootstrap); `projects()` má vlastné N+1.
- `store.message()` maže a znovu zapisuje FTS riadok pri **každej** revízii správy (80 ms batch počas streamu).
- `safePart()` v `control.mjs:41-46` robí `INSERT OR REPLACE` artifactu (až 2 MB string) pri každej perzistencii message partu — pri streamovaní opakovane.
- Frontend: jeden bundle (legacy nevytrieďovať), `merge()` sortuje celé pole pri každej aktualizácii, SSE invalidácie sú široké.
- `server.js` stále číta OpenCode SQLite a spúšťa subprocessy (Herdr, systemctl) na read path legacy endpointov.

---

## 3. Cieľ: princípy v3

1. **Jeden produktový model:** projekt → workspace (priečinok) → konverzácia → turn → beh → výsledok. Konverzácia žije nezávisle od procesu agenta.
2. **Jeden runtime path:** OpenCode headless (default) a Pi SDK za spoločným adapterom. Žiadne Herdr, žiadne `systemctl`, žiadne TUI.
3. **Jedno UI:** len `src/workbench-app.tsx`. Legacy sa maže, Whirl dizajn zostáva.
4. **Server je autorita:** prijatie, fronta, model capture, run stav, usage ledger. Runtime je autorita pre svoj natívny kontext.
5. **Bez terminálového balastu:** žiadny live output, žiadne „Ready to continue“, žiadne „Online“ pill. Stav je kontextová veta: pracuje / čaká na teba / zlyhalo / hotovo s výsledkom.
6. **Model je prvotriedny objekt:** connection → plán → model → schopnosti → cena/usage, s jasnou hierarchiou defaultov a viditeľnou zmenou počas behu.
7. **Kontext má scope:** klip patrí projektu (priečinku), alebo je explicitne General. Nikdy sa nepripája do nesúvisiaceho chatu.
8. **Pravdivosť metrík:** reported vs estimated vs unknown vs not_supported. Žiadne vymyslené kvóty.
9. **Merateľný výkon:** rozpočty v kapitole 8, overované v reálnom nasadení cez Worker/VPC/Tunnel.

---

## 4. Cieľová architektúra

### 4.1 Diagram

```text
Browser (React + Whirl, jedna appka)
 ├─ IndexedDB: drafty, pending commandy, posledný projekt/model
 ├─ TanStack Query: bootstrap, konverzácia, history, offerings, usage
 └─ HTTP commands + jeden SSE stream (seq cursor, replay, resync)
                 │
Cloudflare Worker (edge)
 ├─ login/session/rate-limit
 ├─ ASSETS.fetch priamo pre shell, JS, CSS, fonty (auth pred assets)
 └─ streaming proxy /api/* → VPC → gateway
                 │
workbench-gateway.service (server.js po očistení, 127.0.0.1:8787)
 ├─ auth + login attempt endpoint + health
 ├─ statický fallback (len pre lokálny/dev prístup)
 └─ /api/v2/* → 127.0.0.1:8788 (control)
                 │
workbench-control.service (control.mjs, 127.0.0.1:8788)
 ├─ Store (SQLite WAL): domain state, command queue, events, usage, clips, artifacts
 ├─ Scheduler: per-workspace lease, maxConcurrentRuns, waiting neblokuje
 ├─ Runtime supervisor
 │   ├─ OpenCodeRuntime: jeden `opencode serve` child (pin 1.18.34)
 │   └─ PiRuntime: pi-runner child per beh, idle eviction
 ├─ Model catalog + connections + defaults
 └─ Usage ledger + title joby
                 │
Workspaces: registrované projektové priečinky + git worktrees + General (prázdny control dir)
```

### 4.2 Gateway vs Control

- **Gateway** (`server.js`) sa zoštíhli na ~200 riadkov: `sameOrigin`, login/session, `/api/internal/login-attempt`, `/api/health`, `/api/v2` reverse proxy so zachovaním streamovania, statický fallback pre `vite dev` a núdzový prístup. Všetko ostatné sa maže.
- **Control** je jediný vlastník doménových dát a runtime-ov. Beží ako riadna systemd jednotka s dátami v `~/.local/share/workbench` (nie `/tmp`, nie v repe), `MemoryMax` podľa merania, `Restart=always`.
- OpenCode `serve` zostáva childom control (dedí pamäťový limit); pri štarte sa overí verzia a health; pri páde sa reštartuje supervisorom.
- Static: Worker servíruje `ASSETS.fetch` priamo po auth. VPS sa pre statiku použije len ak edge asset nemá (404 fallback).

### 4.3 Runtime adapter a capabilities

Zjednotiť existujúce triedy pod explicitný kontrakt (aj keď nie formálne TS rozhranie, minimálne spoločnú štruktúru metód a capability objekt):

```ts
type Capabilities = {
  images: boolean; files: boolean; modelSwitchPerTurn: boolean;
  questions: boolean; permissions: boolean; steering: boolean;
  usage: boolean; fork: boolean; workflow: boolean; // workflow = opencode plan/build
};
```

- `opencode`: images, files, questions, permissions, usage, fork → všetko zapnuté.
- `pi`: images, files, usage, fork(session file); **questions/permissions nepodporuje** → UI nesmie zobraziť permission kartu pre pi beh a picker/engine filter to musí vedieť.
- Capability sa ukladá do `RuntimeBinding`/konverzácie a posiela sa v `bootstrap` a `view()`; UI renderuje len reálne funkcie.

### 4.4 Run state machine a scheduler

Stavy (už v schéme `commands.status`):

```text
queued → starting → running ⇄ waiting_for_input
                      ├→ stopping → cancelled
                      ├→ failed | interrupted | uncertain
                      └→ succeeded
```

Zmena oproti dnes:

1. Beh sa spúšťa ako **asynchrónna úloha**, ktorá NEblokuje scheduler po celý čas.
2. Scheduler prideľuje **lease na workspace** (directory + project): jediný writer na workspace. Rôzne workspace môžu bežať paralelne do `MAX_CONCURRENT_RUNS` (default 1 na tomto VPS, konfigurovateľné).
3. `waiting_for_input` uvoľní slot pre iné workspace; beh ďalej žije a čaká na odpoveď; pri odpovedi sa vráti do `running`.
4. Globálny memory guard: pred dispatchom `MemAvailable` + rezerva (nie 192 MB ako dnes, ale meraná hranica, napr. 400 MB), plus cgroup tlak.
5. `stop` zastaví beh a pozastaví frontu (`paused=1`), `resume` ju znovu spustí — to už existuje a je otestované; doplniť UI affordancie.
6. Pri reštarte control: `store.recover()` označí aktívne behy `interrupted`; reconciler pre OpenCode aj Pi sa pokúsi dohľadať výsledok podľa `native_message`/native session a prepnúť na `succeeded`, ak je dokončený.

### 4.5 Eventy a dokončenie

- **Primárne:** natívne eventy (OpenCode `/event`, Pi `session.subscribe`) mapovať na normalizované eventy a run stav.
- **Sekundárne (repair):** snapshot reconciliation pri otvorení streamu, po diere v eventoch, pred terminálnym stavom. Nie každé 3 s naslepo.
- Dokončenie: OpenCode — message `time.completed` pre posledný assistant message po `session.idle`; Pi — **`agent_settled`** (po retry/compaction), nie `agent_end` ani holý `waitForIdle`.
- Persistovať najprv, potom publikovať (už platí); textové delty batchovať 80–100 ms; terminálne eventy vždy flushnúť.
- SSE: `id: seq`, heartbeat 20 s, replay ≤500 eventov, inak `resync` (už existuje). Dopočítať: `Last-Event-ID` podpora na gateway aj control (už je `last-event-id` header) a reconnect backoff v klientovi.

---

## 5. Model picker, connections a usage (hlavná produktová požiadavka)

### 5.1 Doménový model

```text
Engine      opencode | pi
Connection  konkrétny účet: opencode-go (API/plan), openai (OAuth subscription), openai (API key), …
Provider    openai | opencode-go | anthropic | …
Model       konkrétna ponuka dostupná cez connection a engine
```

Konverzácia má `engine` (fixný) a `modelPref` (default pre ďalšie turny). Každý **command nesie model zachytený pri prijatí** — to je už implementované a otestované (`store.accept`, `command.model`). Aktívny beh je immutable, queued turny nesú vlastný model.

### 5.2 Katalóg a connections

- `GET /api/v2/models` rozšíriť: `connectionId`, `connectionLabel`, `authKind` (`subscription` | `api_key`), `planLabel`, `available`, `unavailableReason`, `pricing {input, output, currency}` + `pricingSource` + `catalogFetchedAt`, `favorites`, `recent`, `defaults` (user/project/conversation).
- Katalóg zostáva single-flight s last-known-good (`control.mjs:138`); doplniť `updatedAt`, `version`, a to, že nedostupný provider nemá zhodiť celý zoznam.
- Connections handler (`control.mjs:226-230`) prepísať čitateľne: normalizované pole {id, engine, provider, label, auth, health, modelCount, quotaStatus, consoleUrl}.
- Health: posledný úspešný katalóg pre provider; OAuth expirovaný / API key neplatný sa musí dať rozpoznať (aspoň cez zlyhaný refresh a chybovú správu).

### 5.3 Picker UX (univerzálny, jeden komponent všade)

Zavretý chip: názov modelu + malý znak connection/plánu (`Go`, `OpenAI`). Otvorený:

1. **Search** (typeahead cez názov, provider, model ID) + klávesnica (šípky, Home/End, Enter, Esc).
2. **Sekcie:** Recent → Favorites → podľa connection (napr. „opencode-go · plan“, „OpenAI · subscription“, „OpenAI · API key“).
3. **Riadok:** názov, vendor, connection alias, capability chipy (vision, tools, reasoning), context/output limit, cena alebo `Plan`, dostupnosť.
4. **Nedostupné modely** až za „Show unavailable“ s dôvodom; nikdy sa nemiešať medzi dostupné.
5. **Akcie:** „Use in this chat“ (jednorazovo pre ďalší turn), „Set as chat default“ (conversation.modelPref), „Set project default“, „Set my default“; pri projekte/účte ukázať existujúci default.
6. **Reasoning effort** ako samostatný výber len pre modely s `variants`/reasoning podporou; pri pi je pevná škála off/minimal/low/medium/high.
7. Virtualizovať zoznam pri >100 položkách; mobil ako bottom sheet.
8. V hlavičke chatu vždy vidieť: **Active model** (bežiaci beh) a **Next model** (pre ďalší turn), keď sa líšia. Pri zmene počas behu nesmie chip tvrdiť, že už beží nový model.

### 5.4 Default hierarchia (vysvetlená v UI)

```text
model z konkrétneho (queued) commandu
  → conversation.modelPref
  → project.defaults[engine]
  → user default (settings default.<engine>)
  → fallback: prvý dostupný model daného engine (nie hardcoded flash)
```

- `defaultModel()` prestať hardcodovať `flash`, namiesto toho explicitný onboarding default pri prvom pripojení.
- Každý default sa ukladá server-side (multi-device sync už je).
- Pri zmene defaultu UI ukáže, ktoré konverzácie to ovplyvní (len budúce turny, nikdy aktívny beh).
- Chýbajúci/odpojený default: jasný dôvod a výber náhrady, nikdy tiché prepnutie na inú platenú connection.

### 5.5 Usage dashboard

Rozšíriť `usage-view.tsx` na skutočnú obrazovku:

1. **Overview:** dnes / 7 dní / 30 dní / vlastný rozsah; tokens in/out/cache, requests, succeeded/failed runs, odhad cost. Malý denný bar chart (čisté CSS/SVG, bez novej knižnice).
2. **Breakdown:** project → conversation → run; filter engine/provider/model; klik na model otvorí picker detail (usage + favorites + default).
3. **Connections:** stav, auth metóda, počet modelov, posledný refresh, link do provider console, „provider quota not reported“ ak neexistuje API.
4. **Models:** zoznam ponúk s usage stĺpcom, hviezdičkou (favorites) a „set default“ priamo tu.
5. **Pravdivosť:** pri každej metrike `source` (runtime-reported / imported / estimated), `unknownCost` count, cache tokeny normalizované podľa providera (nie univerzálne sčítanie input+cache).
6. Do ledgeru zahrnúť aj title/tag joby a (ak sa niekedy vráti) Ask — dnes je AI usage mimo ledgeru.
7. Záznam na jeden unikátny model request (native message id + binding generation), idempotentne cez `INSERT … ON CONFLICT` (existuje).

### 5.6 Kvóty providerov

- OpenCode Go a OpenAI OAuth (ChatGPT plán) nemajú v otvorenej dokumentácii stabilné quota API použiteľné týmto kľúčom → UI ukazuje **lokálne zaznamenanú spotrebu** + odkaz na provider console.
- Codex app-server `account/rateLimits/read` je inšpirácia, nie dostupná cesta cez OpenCode/Pi.
- Nikdy nezobrazovať „ostáva 80 %“, ak to nie je autoritatívne reportované. `unknown` ≠ `0`.

---

## 6. Projekty a kontext podľa priečinkov

### 6.1 Identita a resolver

- Projekt = stabilné UUID + canonical root (`realpath`) + workspace zoznam (root, podpriečinky registrované explicitne, git worktrees cez `git-common-dir`). Existuje v `store.addProject`/`projectFor`.
- Doplniť: `/projects` API vráti aj `lastUsedAt`, `defaultModel`, `conversationCount`; priečinok mimo rootov sa odmietne (už je allowlist `WORKBENCH_PROJECT_ROOTS`).
- Pri vytváraní konverzácie: vybrať projekt → workspace (ak má viac) → beží v ňom. „General“ = `project_id=null`, prázdny `control/general` priečinok (nie HOME).
- Zmena `projectId` na existujúcej konverzácii je organizačná (existuje); execution directory sa nemení. UI to musí jasne povedať (`workbench-app.tsx:147` to už hovorí, doplniť viditeľnosť).

### 6.2 Chats a priečinky v UI

- Home: namiesto select-u priečinok picker (projekty + workspaces + „General“); zobraziť `~/projects/Foo · main` chip.
- Header chatu: projekt + priečinok (klikateľné na zmenu organizácie).
- Sidebar/history: pri položke jemný projektový podtitulek alebo group-by-project prepínač; filter default = aktuálny projekt, nie prázdny.
- „New conversation in this folder“ pri priečinku v history (jedna klávesa, nový chat v tomto scope).
- Legacy import: už teraz `projectFor(directory)` priradí priečinok; skontrolovať a doplniť hromadnú opravu pre konverzácie, ktorých priečinok je pod projektom, ale `project_id` je null.

### 6.3 Kontextová knižnica (clips)

Tri veci jasne oddeliť (v UI aj v copy):

1. **Systémový clipboard** — Ctrl/Cmd+V do composeru, jednorazové.
2. **Príloha správy** — upload k turnu, immutable, žije s konverzáciou.
3. **Uložený clip** — znovupoužiteľný, scoped na projekt alebo General, sync medzi zariadeniami.

Zmeny:

- Default scope pri ukladaní z chatu = projekt konverzácie; z library = aktuálny filter/General; nikdy „All“ ako default zápis.
- V library zobraziť scope chip, typ, pôvod (konverzácia, zariadenie, súbor, čas), search, pin, move, delete.
- „Add to message“ vloží text na caret alebo pripne obrázok/súbor ako prílohu; viac clips naraz podporiť (multi-select).
- „From project files“: bezpečný zoznam súborov pod projektovým rootom (bez symlink escape), výber 1–N súborov ako prílohy/kontext.
- Clip create/update/delete emituje `clips.changed` (existuje) → iné zariadenia sa aktualizujú bez refocus refetch.
- Pred odoslaním „Context inspector“: presný zoznam textu + príloh + clips, čo ide agentovi; umožní odobrať pred sendom.

### 6.4 Composer a clipboard

- `+` menu: Upload, From project files, From library, Paste (done).
- Insert na caret/selection (už je); pri mixed text+image paste nestratiť ani jednu časť.
- `Paste from clipboard` nech je doplnok — primárne nech funguje natívny Ctrl+V (vrátane obrázkov), s fallbackom a jasným errorom pri chýbajúcom permission.
- Drafty a pending commandy v IndexedDB (existuje); doplniť viditeľný stav „uložené lokálne / prijaté serverom / vyžaduje potvrdenie“ (pending retry UI existuje).

---

## 7. Agentic UX

### 7.1 Čo odstrániť (bez milosti)

- `OutputDialog` a celý live output.
- Herdr pane routing (`#live/...`), `statusLabel`, „Ready to continue“, „Saved history“, „Online“.
- `AI`/Ask panel (`ai.mjs`, `@ai-sdk/*`) — ak zostane potreba „vysvetli mi tento beh“, riešiť to ako nový turn v konverzácii alebo samostatný read-only režim neskôr, nie ako druhý chat.
- `/api/processes` a kill endpoint (bezpečnosť).
- Legacy UI komponenty a staré API endpointy.

### 7.2 Thread a run karta

- Nad odpoveďou jedného turnu kompaktná **Run karta**: stav (queued/working/needs you/failed/stopped), model (a „next: …“ ak sa čaká zmena), elapsed, tokens, Stop.
- Activity (tooly) zbalené (existuje) so súhrnom „Completed 8 actions“ a per-tool lazy artifact fetch (existuje).
- Interakcie (permission/otázka) inline karty (existuje) — len pre opencode; pri pi sa nezobrazujú.
- Pri zlyhaní: `failed: message` + tlačidlá **Retry** (nový command s rovnakým obsahom) a **Dismiss** (odpauznúť frontu).
- Žiadne prázdne stavy typu „Ready when you are.“ — nahradiť kontextom (napr. posledné zmenené súbory projektu alebo nič).

### 7.3 Queue

- Fronta per konverzácia viditeľná a editovateľná pred dispatchom (existuje: remove, model per item, pause/resume).
- Pridať: reorder (drag), edit textu queued položky, jasné poradie a dôvod čakania („beží predchádzajúci turn“, „fronta pozastavená“).
- Stop = zastaví beh a pozastaví frontu; Resume = explicitné pokračovanie. Vždy vidieť, čo sa stane.

### 7.4 Výsledok práce (bolt/v0 pocit)

Postupne (Fáza 5):

- **Changes:** diff zmenených súborov oproti baseline na začiatku behu (vrátane necommitnutých používateľských zmien), karta „3 files changed, +120 −34“ s rozbalením po súboroch. Baseline zachytiť pred spustením runu (git hash + dirty snapshot).
- **Tests:** ak agent spustil testy (tool `bash` s rozpoznateľným príkazom / `test` tool), zobraziť výsledok ako samostatný výsledok, nie schovaný v tool outpute.
- **Artifacts:** patch, report, screenshot ako samostatné objekty (tabuľka `artifacts` existuje) s verejným náhľadom.
- **Child behy (subagents):** zobraziť vnorené pod rodičom (native child sessions sa dnes importujú ako root? — treba filtrovať `parent_id` a zobraziť ich ako child aktivity, nie v sidebare).
- **Fork:** pokračovanie od správy s jasným scope (engine/workspace) — API existuje; doplniť UX a upozornenie na kontext.

---

## 8. Výkon

### 8.1 Rozpočty

| Metrika | Cieľ |
|---|---|
| Vizuálny feedback po Send (optimistic message) | < 50 ms |
| Prijatie commandu na lokálnej API (bez uploadu) | p95 < 150 ms |
| Event → UI (persistovaný) | p95 < 250 ms v reálnom teste cez Worker |
| Prepnutie chatu (cached) | < 100 ms |
| Initial JS | ≤ 180 kB gzip (teraz legacy build ~297 kB gzip; nový bez legacy ~120 kB gzip) |
| Bootstrap odpoveď | < 50 kB a < 100 ms lokálne |
| 1 000+ správ | editor/scroll p95 < 50 ms |
| Idle klient | žiadny chat polling; len SSE heartbeat |
| API pamäť | stabilný plateau 24 h soak; žiadne opakované dosahovanie cgroup max |

### 8.2 Frontend

1. Rozbiť `workbench-app.tsx` na `features/` (shell, chat, home, history, library, usage, models) s lazy routes (dnes lazy len Library/Usage/Thread).
2. SSE handler: aktualizovať cielené query cache podľa typu eventu (message.updated → konverzácia; run.updated → `activeRun`+`queued`; conversation.changed → bootstrap/history; command terminal → usage). Žiadne plošné invalidácie `bootstrap` pri každej udalosti.
3. Normalizovaný transcript store: správy podľa ID + revision, append/merge O(n) bez sort celého poľa (timestampy prichádzajú zoradené).
4. Virtualizovať od >40 riadkov; memo na hotové správy; markdown highlight až po dokončení bloku (skontrolovať `markdown.tsx` a načítať jazyky lazy).
5. Composer izolovať od shell state, aby písanie nere-renderovalo sidebar a thread.
6. Zmazať legacy z entry bundlu; skontrolovať, že lazy chunky sa naozaj načítavajú (dnes `workbench-DyS1Oked.js` vyzerá ako duplicitný chunk).
7. Skutočné meranie: Lighthouse + React profiler na mobile aj desktope, nie len localhost.

### 8.3 Backend (control)

1. `store.list()` a `view()` zbatchovať: jeden dotaz na konverzácie + jeden na posledné commandy + jeden na counts; `projects()` jeden join.
2. FTS update len pri dokončení správy (alebo debounce 1 s po poslednej delte), nie pri každej revízii.
3. Artifact: zapisovať raz (INSERT OR IGNORE) a updatnúť len pri terminálnom stave partu; priebežný output držať v pamäti runu. Retencia: staršie ako N dní a nad veľkosť mazať (a nahradiť odkazom „artifact expired“).
4. `PRAGMA` a prepared statement cache; usage agregácie indexovať (`usage(created, conversation_id)` existuje, doplniť `(provider, model)` a `(command_id)`).
5. Eventy: batch insert v transakcii, retention už existuje; pri veľkom replayi vrátiť resync (existuje).
6. Title job: asynchrónne po prvom assistant message (mimo runu), s usage záznamom; fallback z prvého user textu, nikdy neblokuje chat.

### 8.4 Runtime

- Jeden `opencode serve` proces trvalo; žiadne spúšťanie na request.
- Pi runner idle eviction (existuje 120 s) a jeden child per beh; pri `agent_settled` poslať done a dispose.
- Model catalog refresh mimo request path (existuje), s backoffom pri zlyhaní.
- Attachments: images posielať ako runtime-native file/prilohu, nie base64 v JSON tam, kde to API podporuje (overiť v 1.18.34); veľké textové prílohy nezabaliť do promptu viac než raz.

---

## 9. Produkčná prevádzka

### 9.1 Deployment a systemd

| Unit | Obsah | Limity |
|---|---|---|
| `workbench-gateway.service` | očistený `server.js` | `MemoryMax=128M`, `Restart=on-failure` |
| `workbench-control.service` | `control.mjs` + child `opencode serve` + pi runnery | `MemoryMax` podľa merania (štart 768M, doladiť), `KillMode=control-group`, `Restart=always` |
| `workbench-cloudflare-tunnel.service` | existuje | bez zmeny |

- Dátový adresár: `~/.local/share/workbench` (`WORKBENCH_DATA`), migrácia zo staging `/tmp` sa spraví raz migračným skriptom (DB + blobs + pi sessions). Repo/data ostáva len pre dev.
- Deploy: `npm ci && npm run build` (build + verify + promote), potom `systemctl --user restart workbench-control workbench-gateway`. Build nesmie bežať na živej službe (statiku servíruje edge).
- Promote: najprv nahrať nové hashed assety, potom atomicky prepnúť index (existuje); overiť, že sa to naozaj deje (dnes index ostal na starom builde) — doplniť verifikačný krok „index referencuje existujúce assety“ a fail build inak.
- Static z edge: Worker po auth `env.ASSETS.fetch(request)`; VPS fallback len ak asset chýba (404).

### 9.2 Dáta, migrácie, zálohy

- `user_version` migrácia namiesto `CREATE TABLE IF NOT EXISTS`; každá zmena schémy = verzia + idempotentný upgrade.
- Záloha: `scripts/backup-workbench.mjs` už existuje (VACUUM INTO + blobs + pi sessions + opencode DB). Pridať `systemd --user` timer (denne) a restore drill do runbooku.
- RPO ≤ 24 h pri strate VPS, RTO ≤ 60 min; lokálny reštart nesmie stratiť accepted frontu (durable v SQLite, overené).
- Retention: events 7 dní (existuje), artifacts/attachments s GC len pre nereferencované blobs, staré legacy JSON súbory zmazať po importe.

### 9.3 Pinning a health

- Pri štarte control overiť a zalogovať verziu `opencode` (`opencode --version`) a Pi `package.json`; nezhoda s testovanou verziou = warning, pri zlom health = fail fast s jasnou správou.
- `GET /api/v2/health` rozlíšiť: db ok, catalog ok, opencode ok, pi ok, active runs; gateway `/api/health` nesmie vyžadovať runtime.
- História, library a settings musia fungovať pri výpadku runtime (control to vie; overiť UI degraded stavy).

### 9.4 Observability

- Štruktúrované JSON logy s `requestId`, `clientCommandId`, `conversationId`, `runId`, `engine`; žiadne prompty/credentials.
- Sledovať: accept latency, queue wait, dispatch latency, TTFT, time-to-complete, runtime exit kódy, SSE reconnecty, replay gapy, event loop delay, DB latenciu, memory.
- Worker: traces zapnuté (sú), pridať logy pre 502 na VPC a SSE odpojenia.
- Jednoduché counters endpoint (`/api/v2/metrics`) pre interné použitie — netreba Prometheus na jednom VPS.

### 9.5 Bezpečnosť

- Zmazať process-kill endpoint a všetky Herdr/systemctl cesty.
- Internal key len medzi gateway↔control (existuje), cookie HttpOnly/Secure/SameSite=Strict (existuje), rate limit loginu (existuje).
- Project roots allowlist (existuje), canonical path checks (existuje), upload MIME sniffing (existuje), CSP (existuje v gateway aj Workeri).
- Attachments a artifacts chránené rovnako ako chat (cez auth), žiadne verejné URL.
- Stop smie zasiahnuť len vlastnený run (runtime abort), nie globálne PID.

---

## 10. Fázy a gates

### Fáza 0 — Stabilizácia a nasadenie v2 (0,5–1 deň)

- Spustiť control ako riadnu službu na 8788 s prod dátami; nastaviť `WORKBENCH_CONTROL_PORT` pre gateway; promovať nový UI build.
- Overiť: nové UI sa načíta, chat na oboch engine-och funguje, SSE žije.
- **Gate:** používateľ vidí nové UI a odpoveď agenta bez legacy ciest.

### Fáza 1 — Zmazať legacy a zoštíhliť gateway (1–2 dni)

- Zmazať `App.tsx`, legacy komponenty, `ai.mjs`, `@ai-sdk/*` závislosti, Herdr endpointy a čítanie opencode DB zo `server.js`.
- Import starých JSON (meta, model prefs, clips) je už hotový; po overení ich odstrániť.
- **Gate:** `rg herdr|Herdr` nenájde nič v produkčnej ceste; `npm run build` bundle ≤ ~150 kB gzip; žiadne „Ready to continue“/live output v UI.

### Fáza 2 — Scheduler, eventy, run correctness (3–5 dní)

- Asynchrónne runy, per-workspace lease, `waiting` neuvoľňuje frontu; `MAX_CONCURRENT_RUNS`.
- Event-driven dokončenie (OpenCode idle + message completed; Pi `agent_settled`), snapshot len ako repair.
- Reconciler pre oba engine; retry/dismiss; capabilitiy model v API.
- **Gate:** permission otázka v jednom chate nezablokuje druhý chat; stop/resume; fault testy (reštart control uprostred behu).

### Fáza 3 — Model/connections/usage v3 (3–5 dní)

- Rozšírený katalóg + connections + defaults hierarchia + picker podľa 5.3.
- Usage dashboard podľa 5.5; title joby v ledgeri.
- **Gate:** zmena modelu počas behu je viditeľná ako Active/Next; usage sedí s realitou testovacieho behu; žiadne fake kvóty.

### Fáza 4 — Projekty a kontext (2–4 dni)

- Folder picker a scope inference; library s projektovým defaultom; From project files; context inspector; multi-attach.
- **Gate:** klip z chatu patrí jeho projektu; klip sa nedá omylom pripnúť do iného projektu; worktree/subfolder sa mapuje deterministicky.

### Fáza 5 — Agentický výsledok (3–6 dní)

- Run karta, changes/diff baseline, test výsledky, artifacts náhľad, child behy, retry.
- **Gate:** po behu je z thredu jasné, čo sa zmenilo a či to prešlo, bez otvárania tool outputov.

### Fáza 6 — Výkon a hardening (3–5 dní)

- Batch dotazy, FTS/artifact optimalizácia, selective SSE updates, virtualizácia, bundle budget.
- 24 h soak, fault injection, backup/restore drill, load test cez Worker.
- **Gate:** rozpočty z 8.1 splnené v reálnom nasadení.

### Fáza 7 (voliteľná) — Pi dotiahnutie a paralelizmus

- Pi capabilities (bez permissions), worktree parallel runs, engine handoff UX.

**Odhad spolu:** ~3–4 týždne sústredenej práce; F0 dá okamžitú hodnotu do jedného dňa.

---

## 11. Backlog

| Priorita | Balík | Hotovo, keď |
|---|---|---|
| P0 | F0 nasadenie control + promote UI | nové UI + v2 chat fungujú v produkcii |
| P0 | F1 zmazanie legacy | bundle bez legacy, žiadne TUI cesty |
| P0 | F2 scheduler + event-driven run | waiting neblokuje, fault recovery |
| P0 | F3 model picker + connections + defaults | Active/Next, hierarchia, usage v pickeri |
| P0 | F3 usage dashboard | časové rady, breakdown, provenance |
| P1 | F4 projekt scope pre chats aj clips | default z konverzácie/priečinka |
| P1 | F4 context inspector + project files | presne vidieť, čo ide agentovi |
| P1 | F5 run výsledky (changes/tests/artifacts) | výsledok bez tool outputov |
| P1 | F6 výkon (store, SSE, bundle) | rozpočty splnené |
| P1 | ops: jednotky, migrácia dát, backup timer | reštart/restore bez strát |
| P2 | F7 Pi capabilities/worktrees/handoff | bezpečný paralelizmus |

---

## 12. Testy, ktoré rozhodujú o release

Existujúce (`workbench.smoke.mjs`, `workbench.workflow-test.mjs`) rozšíriť:

- Attachments v prvom aj ďalšom turnе, image aj text.
- Zmena modelu počas aktívneho behu: bežiaci beh si drží model, queued turn má nový, po dokončení sa nový naozaj použije (už čiastočne overené).
- Permission/question v jednom chate + paralelný beh/queue v druhom (F2 gate).
- Reštart control uprostred behu → `interrupted` + reconciler nájde výsledok, žiadne duplicitné odoslanie.
- SSE: výpadok, reconnect s `Last-Event-ID`, gap > 500 → resync, duplicitné eventy sa deduplikujú.
- Usage: idempotencia, cache tokeny, unknown cost, import nezdvojnásobí.
- Clips scope: z konverzácie projektu A sa neuloží do B; General viditeľný všade.
- Legacy import: 60+ konverzácií správne priradených podľa priečinka.
- Frontend: 1167-správový fixture, scroll bez skokov, mobil, klávesnica, IME.
- Ops: restore zo zálohy, migrácia dát, verzia runtime mismatch.

---

## 13. Riziká a ne-ciele

**Riziká:**

- OpenCode API sa medzi verziami mení (`msg_` ID formát, eventy, questions) — pinovať verziu a držať conformance testy.
- Worker/VPC SSE streaming je beta — overiť buffering a idle timeout e2e; fallback priamejšie smerovanie pri výpadku.
- Zmena scheduleru na paralelné runy môže naraziť na RAM (VPS ~3,8 GB, swap plný) — default 1 concurrent, merané zvyšovanie.
- Diff/summary baseline je najnáročnejšia nová funkcia — spraviť jednoducho (git porovnanie + snapshot pred behom), nie vlastný VCS.

**Ne-ciele (nerobiť):**

- Neprerábať vizuál ani framework; Whirl + React + Vite zostávajú.
- Nevracať live output ani terminálové ovládanie.
- Nerobiť multi-tenant SaaS teraz.
- Nepridávať nový polling tam, kde je SSE.
- Nepredstierať provider kvótu, ktorú nevieme získať.
- Nevymieňať OpenCode za Pi „naslepo“ — Pi je rovnocenný adapter, merať kvalitu/úspešnosť.
- Nezavádzať Redis/Kubernetes/mikroservisy na jednom VPS.

---

## 14. Na overenie (spike pred príslušnou fázou)

1. OpenCode 1.18.34: presný tvar `permission.reply`, `question.reply/reject`, `abort`, `fork`, event payloady — conformance test proti staging.
2. Pi 0.87.1: `agent_settled` semantika, správanie pri retry/compaction, možnosti questions/permissions (alebo ich absencia).
3. Worker VPC: SSE streaming (Content-Type, buffering, `no-transform`), idle timeout, správanie pri redirecte.
4. `opencode serve --pure` dopad na pluginy a na project-level inštrukcie (musia sa načítať z priečinka).
5. Pamäťový profil `opencode serve` + 1 beh + 2 beží naraz + Pi child na tomto VPS (pre `MemoryMax` a `MAX_CONCURRENT_RUNS`).
6. Priečinok s medzerou/diakritikou/symlinkom vo workspace resolveri.

---

## 15. Referencie na kód

| Téma | Miesto |
|---|---|
| Scheduler a run loop | `server/control.mjs:150-181` |
| SSE a replay | `server/control.mjs:183-198` |
| API routes v2 | `server/control.mjs:214-309` |
| Store a command admission | `server/store.mjs:132-149` |
| Message persist + FTS | `server/store.mjs:150-159` |
| OpenCode runtime polling | `server/runtimes.mjs:76-108` |
| Pi runner | `server/pi-runner.mjs:29-71` |
| Legacy gateway | `server.js:1233-1744` |
| Nové UI shell | `src/workbench-app.tsx:33-152` |
| Editor/draft/queue | `src/workbench-app.tsx:154-191` |
| Model picker | `src/components/whirl/universal-model-picker.tsx` |
| Usage view | `src/components/whirl/pages/usage-view.tsx` |
| Context library | `src/components/whirl/pages/context-library.tsx` |
| Thread | `src/components/whirl/thread/thread-view.tsx` |
| Testy | `scripts/workbench.smoke.mjs`, `scripts/workbench.workflow-test.mjs` |

---

## 16. Stav implementácie (6. 10. 2026, večer)

Implementované a otestované:

- **F0 nasadenie:** `workbench-control.service` beží na 127.0.0.1:8788 s dátami v `~/.local/share/workbench` (migrované zo staging), gateway proxuje `/api/v2` na 8788, nové UI build je promovaný (`index-DT-lfEGc.js`, ~126 kB gzip initial).
- **F1 čistý gateway:** `server.js` je len auth/login/rate-limit/health/proxy + statický fallback (~460 riadkov namiesto 1769). Zmazané: `App.tsx`, 13 legacy komponentov, `ai.mjs`, `sync-model-catalog`, mŕtve UI primitívy, `ai`/`@ai-sdk/*`/`zod`/`cva` závislosti. Legacy JSON dáta archivované v `~/.local/share/workbench/legacy-archive`.
- **F2 scheduler a runtime:** asynchrónne behy (`runs` mapa namiesto jedného `active`), per-workspace lease, `MAX_CONCURRENT_RUNS` (default 1, env `WORKBENCH_MAX_RUNS`), `waiting_for_input` neblokuje frontu, event-driven dokončenie (OpenCode `session.idle` + message completed; snapshot reconcile len ako repair, 5 s), Pi beží v samostatnom child procese per beh a stop cieli konkrétny beh. Capability mapa v API (`session.capabilities`), retry endpoint (`POST /commands/:id/retry`), reconcile pri štarte, tabuľa runov v `/health`.
- **F3 model/usage:** katalóg obohatený o connection identitu, auth kind, plán, stale flag; `connections()` vrstva prepísaná; hierarchia defaultov bez hardcoded flash; usage API s dennými radmi a breakdownom (model/engine/project); nový `ModelPicker` (grouped by connection, recent, favorites, unavailable, keyboard, set default user/project); usage dashboard s grafom, connections a defaultmi.
- **F4 projekty a kontext:** clips scope sa v editore defaultuje z projektu konverzácie; library so search, scope chip a pôvodom; nový endpoint `GET /projects/:id/files` a `GET /projects/:id/file` (safe, 1 MB limit) + dialog „From project files“ v composeri; `DELETE /projects/:id`.
- **F5 agentický výsledok:** `RunCard` so stavom, modelom, časom, stop/retry, a s changes summary; control zachytáva git baseline pred behom (`git stash create`) a po úspechu ukladá `changes_<commandId>` artifact (súbory, +/−, untracked); automatické generovanie titulkov cez Go model s usage záznamom a manuálnym regenerate.
- **F6 výkon:** FTS index sa aktualizuje debounced (1 s / pri terminal stave), artefakty sa zapisujú efektívnejšie, SSE klient aktualizuje cielené cache (žiadne plošné invalidácie pri každej udalosti), bundle bez legacy.
- **Ops:** denný `workbench-backup.timer` (04:30, overený beh), backup skript pokrýva control DB + blobs + pi sessions + opencode DB; SSE backpressure bug opravený (replay > 16 kB už nezhadzuje spojenie); systemd sandbox control služby má zapisovateľné `~/projects` (agent musí vedieť zapisovať).
- **Worker (edge):** `worker.js` už servíruje shell/fonty/assety priamo z `ASSETS` a na VPS posiela len `/api/*`. **Čaká na `wrangler deploy`** — v tomto prostredí nie je Cloudflare prihlásenie.

Overené end-to-end na tomto VPS:

- `npm run check` (node --check + `tsc --noEmit`), `npm test` (7/7), build a promote UI.
- `workbench.smoke.mjs`: OpenCode aj Pi beh, idempotentné prijatie, usage, scoped clips.
- `workbench.workflow-test.mjs`: attachment, resume kontext, zmena modelu medzi turnmi, pauznutá fronta + resume, SSE eventy cez gateway.
- Manuálny E2E v git projekte: agent vytvoril súbor, `changes_<id>` artifact obsahoval `hello.txt +2`, titulok sa vygeneroval, usage ledger má title-job záznam.

Zostáva (vedome odložené):

- `wrangler deploy` Workera (edge static + streaming; potrebné prihlásenie).
- Queue reorder/edit (dnes remove + model vidno; pause/resume funguje).
- Pi reconciler po páde (OpenCode reconciler hotový; Pi behy ostávajú `interrupted` s tlačidlom Retry).
- Batch dotazy v `store.list()`/`view()` (N+1 dnes zvláda rýchlo; odložené ako meraná optimalizácia).
- „Changes“ karta iba pre git repozitáre (nie je git → karta sa nezobrazí).
- UI pre `DELETE /projects/:id` (API hotové).
