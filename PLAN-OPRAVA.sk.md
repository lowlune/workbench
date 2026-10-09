# Plán kompletnej opravy Workbenchu

Dátum: 2026-10-08 · Repo: `~/projects/Workbench`

Cieľ: dostať prompt rail do použiteľného stavu bez regresií, dokončiť upload
ľubovoľných súborov, zjednotiť deploy a upratať.

---

## 0. Aktuálny stav

- **Hosting = variant A**: UI shell servíruje Cloudflare Worker (`worker.js`,
  `env.ASSETS` z `./public`), API ide cez VPC tunel na VPS. **UI zmena sa
  prejaví len po `npm run deploy`** (build + `wrangler deploy`). `npm run build`
  sám mení iba lokálnu kópiu na VPS.
- **Rail**: vrátený na pôvodnú verziu — virtualizovaný transkript
  (`@tanstack/react-virtual`, `enabled: rows.length > 80`) + samostatný
  `ConversationNav` (sused v `chat-view`), ktorý počíta aktívny tick z pomeru
  scrollu a skáče cez `scrollIntoView`/ratio.
- **Sandbox agentov**: vypnutý (`WORKBENCH_SANDBOX=off` v
  `workbench-control.service`).
- **Upload ľubovoľných súborov**: backend hotový a beží (upload PDF/ZIP = 201).
- **Necommitnuté zmeny**: steer fix, „tool calls“ label, upload prílohy, build
  artefakty. Odporúčam commitnúť (viď §5).

---

## 1. Prompt rail — hlavný problém

### Prečo nefunguje (koreňové príčiny)
1. **Dva zdroje pravdy.** Rail kreslí ticky z backend `/prompts` (všetky user
   správy), ale pozíciu/skok počíta z riadkov transkriptu. Pri importovaných
   (legacy) sessions sa **ID líšia** → párovanie podľa ID zlyhá.
2. **Paginácia.** Transkript načíta posledných 30 správ (`messagesPage`,
   `server/control.mjs:627`). Pri dlhom ťahu je v okne <2 user prompty → rail
   sa skryje alebo je nepoužiteľný.
3. **Virtualizácia.** Pri >80 riadkoch sú offscreen riadky odmountované, takže
   rail nemá DOM box a padá na hrubý odhad. `measurementsCache` offsety sú
   navyše posunuté o padding (chýbajúci `scrollMargin`).
4. **Ratio mapovanie** ignoruje rôzne výšky ťahov → aktívny tick nesedí.

### Varianty riešenia
- **A) Bez virtualizácie + rail z načítaných riadkov.** Presné (čisté DOM), ale
  pri stovkách riadkov drahšie (render + stream updaty). Overené funkčné.
- **B) Virtualizácia so správnym `scrollMargin` + rail z riadkov.** Výkon aj
  presnosť; treba nastaviť `scrollMargin` na offset obsahu v scrollery a skoky
  cez `scrollToIndex` (instant) + dvojfázovú korekciu. Krehkejšie.
- **C) Načítať celú históriu + virtualizovať.** Plný rail, ale ťažší load.

### Odporúčanie
**B** (výkon + presnosť), s jasnými pravidlami:
1. **Jediný zdroj pravdy**: rail (ticky, aktívny index, skok) odvodzovať z
   `rows` v `ThreadView`, nie z backend `/prompts`. Voliteľne `/prompts` použiť
   len na to, koľko stránok doťahať.
2. **`scrollMargin`**: zmerať offset virtualizovaného kontajnera voči
   scroll‑elementu a odovzdať ho `useVirtualizer({ scrollMargin })`. Potom sú
   `measurementsCache[i].start` aj `scrollToIndex` presné.
3. **Aktívny tick**: „posledný prompt, ktorého riadok prešiel hornou hranou“;
   pri dne = posledný. Zdrojom je `measurementsCache` (+ `scrollMargin`) alebo
   DOM pre ne‑virtualizované.
4. **Skok**: `virtual.scrollToIndex(index, { align: 'start' })` (instant) +
   jedna korekcia `scrollIntoView` po mounte.
5. **Auto‑load**: pri otvorení doťahať pár stránok, kým nie je aspoň N promptov
   (napr. 8) alebo koniec histórie; `loadOlder` už zachováva scroll.
6. **Virtualizáciu ponechať** (performance), ale rail nesmie závisieť na
   odhadnutých pozíciách.

### Acceptance
- Klik na tick i → aktívny tick = i, a daný prompt je na vrchu viewportu.
- Scroll hore/dole → aktívny tick presne sleduje (pri dne posledný).
- Funguje pre: krátky chat, dlhý virtualizovaný chat, legacy session.
- Žiadny skok scrollu pri prepend‑ovaní starších správ.

---

## 2. Upload ľubovoľných súborov (takmer hotové)

### Hotové
- `server/control.mjs` `upload`: ľubovoľný mime, limit **50 MB**, obrázky sa
  sniffujú (magic bytes), ostatné sa uložia ako blob s príponou z názvu/mime.
- `server/pi-runner.mjs` + `server/runtimes.mjs`: obrázky → vision; malé
  textové → inline do promptu; **ostatné → agent dostane cestu** k súboru
  (`attachment.filePath` v `blobs/`), aby ich spracoval nástrojmi.
- Frontend: `uploadAttachment` (ľubovoľný typ), composer povolí všetky súbory
  (picker bez `accept`, drag‑drop), tray zobrazí obrázok alebo chip s názvom.

### Ešte overiť / doladiť
- **E2E test**: nahrať PDF/ZIP v UI → poslať → agent prečíta cestu a spracuje
  (napr. `pdftotext`, `unzip`). Overiť, že `filePath` je v sandboxe (aj keď
  je off) čitateľná.
- **Dostupnosť nástrojov**: či má agent `pdftotext`/`unzip`/`python3`. Ak nie,
  doplniť do image alebo použiť iný nástroj.
- **Plan mode**: blobs sú read‑only bind → agent vie čítať, nie zapisovať.
- **Veľké súbory**: 50 MB cez Worker/VPC tunel — overiť limity (CF Workers
  request body limit) a streamovanie cez `server.js` proxy.
- **Úklid**: zmazať testovacie bloby (`att_*`) po teste.

---

## 3. Chat UI / dock (z návrhu, neimplementované)

Statický návrh bol v `/tmp/opencode/wb-dock-preview.html`. Ak sa má zaviesť:
- Zlúčiť status + otázku + queued + composer do jedného docku (menej `blur`).
- Pri otázke: náhľady obrázkov pri možnostiach (option `image`), „Niečo iné…“
  rozbaľovač, jednoklik + klávesy.
- Queued: presné „odošle sa keď…“, nezrezávať text, väčší Steer.
- Composer počas blokovania stlmiť.
- Backend: pridať `image` do option typu + do `/interactions`.

---

## 4. Hosting / deploy drift (prečo „nefunguje to“)

- **Teraz**: UI zmena vyžaduje `npm run deploy` (edge). Zabudnutý deploy =
  používateľ vidí starý bundle (presne to sa stalo).
- **Riešenie A**: zostriť disciplínu — jediná cesta von je `npm run deploy`
  (prípadne GitHub Action na push).
- **Riešenie B (odporúčané)**: prejsť na **single‑origin** cez named Cloudflare
  tunnel na `127.0.0.1:8787` (`server.js` už má login) → stačí `npm run build`,
  žiadny drift, jeden origin pre UI aj API. (V `docs/archive/PLAN-HOSTING.sk.md`.)
- Pridať `/version` endpoint (hash assetov) a upozornenie v UI pri zhode
  VPS vs. edge.

---

## 5. Hygiena / commit / testy

- **Commitnúť** funkčné zmeny: steer fix, „tool calls“ label, upload prílohy.
- `public/assets` obsahuje veľa build artefaktov (untracked) — zvážiť
  `.gitignore` alebo ponechať len posledný build; promote drží 7 dní.
- Pred deployom vždy: `npm run check` + `npm test` (50/50) + `tsc --noEmit`.
- Zdokumentovať do `README`/`ARCHITECTURE.md`.

---

## 6. Poradie prác (návrh)

1. Commit aktuálneho funkčného stavu (steer, tool‑calls, upload).
2. E2E overiť upload PDF/ZIP (nahrať → poslať → agent spracuje).
3. Rail podľa §1 variant B (jediný zdroj pravdy + `scrollMargin`), otestovať na
   3 typoch session (krátka, dlhá virtualizovaná, legacy).
4. Rozhodnúť hosting (A disciplína vs. B single‑origin) a nastaviť deploy.
5. Voliteľne dock redesign (§3).
6. Úklid + dokumentácia.
