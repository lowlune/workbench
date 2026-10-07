# PLAN: Vertikálne taby pre chat view

**Dátum:** 6. október 2026
**Repozitár:** `~/projects/Workbench`
**Cieľ:** pridať k chat-first dashboardu **vertikálny pruh tabov otvorených chatov**,
aby sa dalo mať naraz otvorených viac konverzácií, rýchlo medzi nimi prepínať,
vidieť ich stav (beží / čaká na teba) a nezahltiť pritom hlavnú plochu.

> Poznámka: toto je len plán (návrh). Nič sa týmto ešte neimplementuje.

---

## 1. Rozsah a princípy

- **Taby = otvorené chaty**, nie trvalá história. História zostáva v sidebari/search.
- Jeden chat môže byť otvorený v tabu; opakované otvorenie ho len aktivuje (žiadne duplicitné taby).
- Tab nesie: názov, stav (running/attention), prípadný unread badge, close, pin.
- Chat-first: taby sú tenké a nenápadné; chat je stále hlavný.
- Žiadny nový proces/worker; je to čisto UI vrstva nad existujúcim durable modelom
  (Chat = durable konverzácia, Run = aktivácia; nič z toho sa nemení).

## 2. Súčasný stav (do čoho zapadá)

- `src/App.tsx`: jednoduchý hash routing `#chat/:id`, jeden `route.sessionId`,
  jediný renderovaný `ChatView`. Stav draftov je v `App` (per session key).
- `Sidebar` už má: Home/Search/History/Clipboard/Usage, **Running**, **Needs attention**,
  projekty a Recent. To zostáva; taby sú doplnok, nie náhrada.
- `ChatView` prijíma `session`, `queued`, `draft`, ... a je bezstavový voči tomu,
  ktorý chat je otvorený — dá sa mountnúť pre ľubovoľné `sessionId`.
- Dáta: TanStack Query `['conversation', id]`, `['prompts', id]`, SSE stream v App.
- Persistencia už existuje: `localStorage` (téma), `IndexedDB` (drafty), server `settings`.

## 3. UX — ako to má fungovať

### 3.1 Umiestnenie
Tenký **vertikálny pruh medzi sidebarom a chatom** (nie ďalší veľký sidebar):

```
[ Sidebar 17rem ] [ Taby ~2.75rem, collapsible ] [ Chat ]
```

- Default: zbalený na **ikonový/tenký pruh** (len farebný status + iniciála/number).
- Hover alebo klik na toggle pruh **rozšíri** na ~14–15rem s názvami (plynulá
  `transition-[width]`), bez posunu chatu (overlay-gutter alebo width animation).
- Voliteľne „tabs on the right" neskôr (nice-to-have; default vľavo pri chate).

### 3.2 Jeden tab
- Riadok: status dot (working/attention/queued) + názov (truncate) + close (hover).
- Aktívny tab: jemné `bg-accent` + ľavý 2px indikátor.
- Stavové farby zdieľané so sidebarom: working = DotsRing, attention = jantárová,
  queued = neutrálna, failed = červená.
- Tooltip (celý názov, projekt, stav, elapsed).
- Unread/attention badge (bodka) keď sa niečo deje v neaktívnom tabu.
- Pin (pripnúť navrch, nezatvorí sa „close all").

### 3.3 Interakcie
- Klik = aktivovať.
- Middle-click / close tlačidlo = zavrieť (nespúšťa stop; run beží ďalej).
- Drag & drop = zmeniť poradie.
- Right-click = existujúce `useSessionMenu` (rename/archive/delete/pin/…).
- „Close others" / „Close all" v context menu pruhu.
- `+` v pruhu = nový chat (Home / new task).

### 3.4 Klávesnica
- `Ctrl/Cmd + Alt + ↑/↓` (a `Ctrl+Tab` / `Ctrl+Shift+Tab`) = predchádzajúci/ďalší tab.
- `Ctrl/Cmd + 1..9` = skok na N-tý tab.
- `Ctrl/Cmd + W` = zavrieť aktívny tab (ak nie je fokus v editore/popup).
- `Ctrl/Cmd + T` = nový chat (Home).
- Esc priority: popup/modal/viewer > interrupt run > (taby neskôr zvážiť).

### 3.5 Mobile
- Taby ako **horizontálny scrollovaný pruh** nad composerom (nie vertikálny),
  alebo skryté a dostupné cez sidebar. Vertikálny pruh má zmysel len md+.

## 4. Dátový model a perzistencia

### 4.1 Klientský stav (`src/lib/tabs.ts`)
```ts
interface TabsState {
  order: string[];            // conversation ids, order
  activeId: string | null;
  pinned: string[];           // subset, floated to top
}
```
- Persistencia: `localStorage['workbench-tabs']` (okamžité, per zariadenie).
- Voliteľne: sync cez server `settings.openTabs` (multi-device) — P2.
- Per-tab **scrollTop** (Map id→px) v pamäti + `sessionStorage` (reload) — P2.
- Drafty zostávajú ako dnes (IndexedDB, kľúč = session id).

### 4.2 Reconciliation (kritické)
Taby sa musia vyrovnať s realitou:
- Chat zmazaný → odstrániť tab (a aktivovať suseda).
- Chat archivovaný/hidden → zavrieť tab, alebo nechať s „archived" značkou (rozhodnutie: zavrieť).
- Nový chat vytvorený z Home/composeru → pridať tab a aktivovať.
- Neznámy id v `order` (napr. z iného zariadenia) → načítať cez `getSession`, inak zahodiť.
- Limit: napr. max 12 otvorených tabov (staršie neaktívne sa zatvárajú s toastom), konfigurovateľné.

## 5. Stavová architektúra (rozhodnutia)

1. **Jeden `ChatView` pre aktívny tab** (nie N mountnutých). Dôvod: výkon,
   jedna SSE aktualizácia, žiadne skryté virtuálne scrollery, jednoduchšie drafty.
   - Neaktívne taby držia len „light" stav: title, status, attention, last activity —
     odvodené z `overview`/SSE, nie z plného transkriptu.
   - Pri prepnutí sa `['conversation', id]` načíta z cache (staleTime už je), takže
     prepnutie je okamžité; ak treba, krátky skeleton.
2. **Aktívny tab = routa**: `#chat/:id` zostáva zdrojom `activeId`; taby sa
   synchronizujú s hash-om (deep-link, back/forward, reload otvorí správny tab).
3. **Zdieľaný stav v App**: `activeId` už existuje (`route.sessionId`); pridá sa
   `tabs` store + handler `openTab/closeTab/activateTab/reorderTabs`.
4. **SSE**: existujúci multiplex stream v App; taby čítajú stav z `overview`
   (running/attention) — netreba nové subscriptiony.
5. **Notifications**: klik na notifikáciu pre daný chat aktivuje jeho tab (ak je
   otvorený) alebo ho otvorí.

## 6. Backend

Zámerne **minimálny**:
- Žiadne nové endpointy pre samotné taby (klientský stav).
- Voliteľne `POST /api/v2/settings {openTabs}` + čítanie v `bootstrap` pre
  cross-device sync (P2). Musí byť tolerantné na neznáme/zmazané id.
- Existujúce endpointy (`/conversations/:id`, `/overview`, `/events`) stačia.

## 7. Komponentová štruktúra

```
src/lib/tabs.ts                     # store (get/set/reorder/pin/reconcile)
src/components/whirl/tabs/
  vertical-tabs.tsx                 # pruh (collapsed/expanded, drag, overflow)
  tab-row.tsx                       # jeden tab (status, title, close, menu)
  use-tabs-shortcuts.ts             # klávesnica
src/App.tsx                         # wiring: tabs state ↔ route ↔ ChatView
```

- `VerticalTabs` props: `{ tabs: TabView[], activeId, expanded, onActivate, onClose,
  onReorder, onToggleExpanded, onNew, onContextMenu, onMenuAt }`.
- `TabView` je odvodený (nie duplikovaný stav): `{ id, title, status, attention,
  pinned, projectId, updated }`.

## 8. Výkon

- Iba aktívny `ChatView` mountnutý; neaktívne taby = ľahké riadky.
- Žiadne nové polling slučky; stav tabov z `overview` (už aktualizovaný SSE).
- Drag/reorder bez re-renderu celého chatu (izolovaný store + `useSyncExternalStore`).
- Pri veľkom počte tabov: scroll v pruhu, prípadne virtua­lizácia (>30).
- Prepnutie tabu nesmie spôsobiť refetch celého bootstrapu.

## 9. Prístupnosť

- `role="tablist"` (vertical), `role="tab"`, `aria-selected`, `aria-controls`,
  `tabIndex` roving; aktívny panel `role="tabpanel"`.
- Plná klávesová obsluha (šípky v tabliste, Home/End, Delete na close).
- Focus viditeľný; `prefers-reduced-motion` rešpektované pri width/scroll animáciách.

## 10. Edge cases

- Chat s `paused`/`interrupted` → tab ostáva, stav „paused/interrupted", Resume v chate.
- Bežiaci run v neaktívnom tabu: badge + DotsRing, **auto-neaktivovať** (len notifikácia).
- `General` chat bez projektu → tab funguje rovnako (projectId null).
- Zmazaný projekt (missing folder) → tab otvorí read-only fallback (už existuje).
- Dva taby z rovnakého projektu s bežiacimi runmi → dovolené (worktree izolácia).
- Reload s neplatným `#chat/:id` → fallback na posledný platný tab / Home.
- Cross-device: id, ktoré lokálne neexistuje → po reconciliácii sa zahodí.

## 11. Fázy implementácie

**P1 — jadro (must):**
- `tabs.ts` store + persistencia do localStorage.
- `VerticalTabs` collapsible pruh, aktivácia/close, status dot, sync s `#chat/:id`.
- Reconciliation s `overview` (zmazané/archivované).
- Klávesy: next/prev, Cmd+1..9, Cmd+W, Cmd+T.
- Mobile: horizontálny pruh.

**P2 — polish:**
- Drag & drop reorder, pin, „close others/all".
- Per-tab scroll restore.
- Cross-device sync cez `settings.openTabs`.
- Unread/attention badge a klik na notifikáciu → aktivuj tab.

**P3 — nice-to-have:**
- „Tabs on the right" / split view (dva chaty vedľa seba) — samostatná epika.
- Zbalenie do sidebaru ako sekcie „Open".

## 12. Acceptance (testovať keď sa implementuje)

1. Otvor 3 chaty → 3 taby; prepínanie je okamžité (<100 ms z cache).
2. Reload stránky → taby a aktívny tab sa obnovia; scroll sa obnoví (P2).
3. Bežiaci run v neaktívnom tabu → badge, chat sa neprepne sám.
4. Zavretie tabu nepreruší run; znovuotvorenie zobrazí priebeh.
5. Zmazanie/archivácia chatu zatvorí tab a aktivuje suseda.
6. Klávesové skratky fungujú vrátane Cmd+1..9 a Cmd+W (mimo editora).
7. Mobile: horizontálny scroll taby, bez rozbitia layoutu.
8. 12+ tabov: pruh scrolluje, UI ostáva plynulé, žiadny refetch bootstrapu.

## 13. Riziká / rozhodnutia

- **Mount stratégia:** jeden aktívny `ChatView` (nie N). Ak by používateľ chcel
  žiť v dvoch chat návštevách, rieši sa to až split view v P3.
- **Stav vs routing:** `activeId` je hash; `order/pinned` je localStorage. Jedno
  je pravda pre „čo je otvorené", hash pre „čo je aktívne".
- **Duplicita so sidebarom:** sidebar zostáva zdroj histórie; taby sú „pracovná
  sada". Ak sa to bude zdať duplicitné, v P2 vieme Recent v sidebari zredukovať.
- **Výkon:** žiadne nové SSE kanály ani polling; taby sú derivát `overview`.
```
