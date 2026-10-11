# 015 — Bug scan a plán opráv

**Dátum:** 2026-10-11
**Stav:** implementované a overené v pracovnom strome; bez deployu
**Rozsah:** UI pre nový chat a nastavenia, kontrola assetov pri check/build. Existujúce necommitnuté zmeny zostali zachované.

## Opravy

### P1 — Predvolený engine

- Nastavenia teraz ukladajú `defaultEngine` cez existujúce `POST /settings` a obnovia bootstrap po uložení.
- V dialógu nového chatu možno zvoliť Pi alebo OpenCode ešte pred vytvorením konverzácie.
- Ukladanie blokuje opakované odoslanie, zobrazuje stav a pri chybe oznámi neúspech.

### P2 — Workspace nového chatu

- Nový chat rešpektuje filtrovaný projekt, potom workspace aktívneho chatu a platnú poslednú voľbu.
- Ak kontext nie je jednoznačný, zobrazí výber workspace namiesto tichého výberu prvého projektu. Dostupný je aj „General (no project)“.

### P2 — Integrita UI assetov

- Pridaný `scripts/check-ui-assets.mjs`, ktorý kontroluje odkazy v HTML a pokračuje cez JS importy a CSS URL/importy.
- `npm run check` kontroluje aktívny `public/`; build kontroluje staging bundle a chýbajúce statické súbory overuje voči existujúcemu `public/`.
- Kontrola pred propagáciou odmietne chýbajúce hashované assety.

## Overenie

- `npm run check` — úspech; TypeScript, runtime/radius kontroly a assety prešli.
- `npm test` — úspech: 54 testov, 0 zlyhaní.
- Staging build (`npm run sync:ui-assets`, `npx tsc --noEmit`, `npx vite build`) — úspech; následná kontrola `public/build-staging` oproti statickému `public/` prešla.
- Plný `npm run build` sa nespustil, pretože jeho posledný krok prepíše aktívny `public/index.html` a propaguje assety. Produkčný deploy, commit a reštart služieb sa nevykonali.
- Browser/E2E manuálne overenie workflowu nového chatu zostáva nevykonané.
