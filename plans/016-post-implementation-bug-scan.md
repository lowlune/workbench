# 016 — Bug scan po implementovaných opravách

**Dátum:** 2026-10-11
**Stav:** plánované opravy sú zapracované; bezpečné kontroly prešli. Živý rollout sa nevykonal.
**Rozsah:** pracovný strom Workbench na VPS, správanie scrollu, výber nového chatu, regresné kontroly a balenie UI assetov. Existujúce necommitnuté zmeny zostali zachované.

## Výsledok kontrol

- `npm run check` — úspech; runtime, syntax, TypeScript a odkazy na UI assety prešli.
- `npm test` — úspech: 64 testov, 0 zlyhaní.
- `git --no-pager diff --check` — bez whitespace chýb.
- Izolovaný staging build (`sync:ui-assets`, TypeScript, Vite a kontrola `public/build-staging`) — úspech. Nebol propagovaný do aktívneho `public/`.
- Test promotéra používa dočasný adresár: potvrdil kopírovanie nových assetov, atomické prepnutie indexu a čistenie starých súborov až po prepnutí.
- `npm run test:ui` a `npm run test:edge` neboli spustené: volajú živé API, vytvárajú/mažú konverzácie a spúšťajú modelové behy.
- VPS proces `node server.js` nebol reštartovaný a UI nebolo nasadené. Bežiaci server obsluhuje súbory z `public/`, preto sa zmeny UI po bezpečnom staging builde ešte neprejavili v aktívnej stránke.

## Nálezy a opravy

### P2 — Možný skok na spodok pri načítaní starších správ v krátkom vlákne

**Oprava:** `ThreadView` počas prependovania staršej stránky potlačí automatický live-follow. Po obnove čitateľovej pozície znovu vyhodnotí polohu voči spodnému okraju. Detekcia zámerného pohybu nahor a spúšťanie načítania staršej stránky sú oddelené, takže krátky obsah môže byť naraz pri hornom aj dolnom okraji bez nežiaduceho prechodu na koniec.

**Regresné testy:** nové testy politík pokrývajú potlačenie follow pri prependnutí, pohyb nahor pri spodnom okraji a nezávislosť načítania starších správ od live-follow.

**Obmedzenie:** testy pokrývajú extrahovanú logiku; React komponent nebol namountovaný v izolovanom prehliadačovom teste a živá E2E cesta sa nespúšťala.

### P2 — Aktívny HTML odkazuje na necommitnuté build assety

**Oprava:** `npm run build` teraz najprv zostaví a overí staging balík. Promotér skopíruje nové hashované assety, atomicky prepne `index.html` a staré súbory staršie než 7 dní odstráni až potom. Po propagácii sa znova overia aktívne odkazy. `deploy` a `deploy:dry` používajú tento build krok.

**Regresný test:** izolovaný test promotéra overí poradie operácií a výsledný balík; kontrola assetov sleduje odkazy z HTML, JS, CSS aj statické fallback súbory.

**Prevádzkový stav:** na VPS sa build iba skontroloval v stagingu. Aktívne `public/` ani bežiaca služba sa nemenili.

### P2 — Chýbali bezpečné regresné testy pre výber nového chatu a scroll

**Oprava:** pribudli izolované testy výberu workspace (projekt, aktívny chat, uložená voľba), ignorovania neplatnej preferencie, zachovania vybraného engine, správania General a scroll politík. Kontrola assetov a promotéra majú vlastné regresné testy.

**Obmedzenie:** dialóg React nebol integrovaný s mockovaným API; chybové a duplicitné odoslanie ani klávesnicová prístupnosť nemajú nové komponentové testy. Existujúce živé UI/E2E testy neboli spustené, aby nemenili produkčné konverzácie ani nespotrebovali modelový kredit.

## Zvyšné kroky pred živým nasadením

1. Spustiť schválený release cez `npm run build`/`npm run deploy` v určenom release procese; tento krok mení servované assety.
2. Na izolovanom testovacom stacku doplniť React komponentové testy pre dialóg nového chatu a ručnú/E2E kontrolu prependu krátkej stránky.

## Hranice

- Zachované boli všetky existujúce necommitnuté zmeny.
- Bez commitu, propagácie do aktívneho `public/`, deployu, reštartu služieb a testov proti živým API.
