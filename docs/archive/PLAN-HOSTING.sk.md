# PLAN: Hosting a exposícia Workbenchu

**Dátum:** 6. október 2026
**Repozitár:** `~/projects/Workbench`
**Stav:** návrh do budúcna (nič sa týmto nemení, aktuálne beží variant „A“)
**Cieľ:** zjednodušiť hosting tak, aby UI aj API mali **jeden origin na VPS**,
odstrániť drift medzi edge assetmi a VPS kódom, a znížiť počet pohyblivých častí.

---

## 1. Ako to beží teraz (zistené v kóde a službách)

Hybridný model: **UI shell na Cloudflare edge + backend na VPS**.

```
prehliadač ──HTTPS──► worker "workbench" (CF edge)
                        ├─ ASSETS  ./public    ... HTML/CSS/JS shell
                        ├─ login / HMAC session (vlastná kópia)
                        └─ /api  ──► WORKBENCH_API (VPC Service)
                                        └─ wrangler tunnel / cloudflared
                                             └─► 127.0.0.1:8787 (server.js na VPS)
```

- `worker.js` — servíruje `./public` z edge (`env.ASSETS`), má vlastný login,
  HMAC `workbench_session` cookie a proxy `/api` cez `env.WORKBENCH_API`.
  Komentár v kóde: *„The shell, fonts and hashed assets come straight from the
  edge; only the API and its event stream travel to the VPS.“*
- `worker-alias.js` + `wrangler.alias.jsonc` — worker `w` len forwarduje na `workbench`.
- `server.js` (VPS, `:8787`) — gateway s **kompletným loginom/session**,
  rate-limitingom a servovaním `public/`. Je to plnohodnotný origin.
- `server/control.mjs` (VPS, `:8788`) — control plane, SQLite, runy, worktree.
- systemd user služby:
  - `workbench-console.service` → `server.js`
  - `workbench-control.service` → `server/control.mjs`
  - `workbench-cloudflare-tunnel.service` → `wrangler tunnel run <id>` (VPC)
- `wrangler.jsonc` — `name: workbench`, `assets.directory: ./public`,
  `run_worker_first: true`, `vpc_services.WORKBENCH_API`.
- CF token: `~/.config/secrets/cloudflare-pages.env` (`CLOUDFLARE_API_TOKEN`).

### 1.1 Prečo je to problém

- **Dve kópie UI:** build na VPS zmení `public/`, ale používateľ vidí edge verziu
  až po `wrangler deploy`. Presne to spôsobilo „nefunguje to“.
- **Duplicitný auth:** login/HMAC/session je v `worker.js` aj `server.js`.
- **VPC tunnel je SPOF:** keď spadne, UI sa načíta, ale `/api` vracia 502.
- **Latencia a komplexita:** každý `/api` ide edge → tunel → VPS; assets na CF.
- **Dva deploy postupy** a secrets na dvoch miestach.

---

## 2. Varianty

### A) Súčasný stav — Worker (edge assets) + VPC tunnel na API
+ edge cache assetov, login na edge, VPS nie je vystavený priamo
− drift, duplicita, SPOF, viac častí

### B) **Single-origin na VPS + named Cloudflare Tunnel**  ← odporúčané
```
prehliadač ──HTTPS──► Cloudflare (TLS, DDoS, voliteľne Access)
                        └─ named tunnel (cloudflared)
                             └─► 127.0.0.1:8787 (server.js: UI + /api + login)
                                   └─ control.mjs :8788 (interné)
```
+ jeden origin, jeden build (`npm run build` na VPS), žiadny drift
+ `server.js` už má login → netreba worker
+ UI aj API zdieľajú rovnaký pád (žiadny „načítané ale mŕtve“ stav)
+ free, cloudflared už na stroji je
− assety nejdú z edge (pre 1–pár používateľov irelevantné)
− tunnel je stále SPOF (ale jedna vec, nie dve)

### C) B) + **Cloudflare Access** (Zero Trust) pred hostname
+ SSO/MFA, IP/identity policy, dá sa vypnúť vlastný login
+ free tier do 50 users
− ďalšia konfigurácia; nutné, len ak chceš obísť vlastný login

### D) Priamy origin (A record + Caddy/nginx, „orange cloud“)
+ najjednoduchšie, plná kontrola
− IP origin je vystavená, treba firewall; bez Access
− menej bezpečné než tunnel; neodporúčam ako default

### E) PaaS (Fly/Railway/Render) pre backend
− **nevhodné:** potrebuješ dlhobežiace procesy, git worktree, perzistentný
  filesystem a SQLite. Backend musí ostať na VPS.

**Verdikt:** pre tento use-case prejsť na **B)**, prípadne **C)**.

---

## 3. Migrácia na B) (návrh krokov)

1. **Named tunnel**
   - `cloudflared tunnel create workbench`
   - DNS: `cloudflared tunnel route dns workbench app.<domena>`
   - `~/.cloudflared/config.yml`:
     ```yaml
     tunnel: <TUNNEL_ID>
     credentials-file: ~/.cloudflared/<TUNNEL_ID>.json
     ingress:
       - hostname: app.<domena>
         service: http://127.0.0.1:8787
       - service: http_status:404
     ```
2. **systemd služba** `workbench-tunnel.service`:
   `cloudflared tunnel run workbench` (nahradí `wrangler tunnel run`).
3. **Vypnutie starých služieb:** `workbench-cloudflare-tunnel.service` (VPC) stop/disable.
4. **worker.js / wrangler.alias.jsonc:** ponechať archivované alebo zmazať;
   odstrániť VPC binding `WORKBENCH_API` z `wrangler.jsonc` (ak sa worker ruší).
5. **Overiť `server.js`:** login, cookie `Secure`, `x-forwarded-proto`,
   `trustedProxy` vetva (niektoré checky sa správajú inak za proxy) — doladiť,
   aby za tunnelom fungovalo `trustedProxy` správne.
6. **SSE:** overiť, že `/api/v2/events` streamuje cez tunnel (funguje, len
   overiť buffering / `Cache-Control: no-store`).
7. **UI build:** stačí `npm run build` na VPS (promote do `public/`); reštart
   `workbench-console.service`.
8. **(voliteľne C)** Cloudflare Access policy na `app.<domena>`; potom sa dá
   vlastný login v `server.js` vypnúť alebo nechať ako druhý faktor.
9. **Cleanup:** doplniť do README, aktualizovať `WORKBENCH-PRODUCTION-PLAN`.

---

## 4. Ak ostaneme pri A) (edge assets)

Potom zaviesť disciplínu, aby drift nevznikol:

- **Jediná cesta ako dostať UI von je `npm run deploy`** (build + `wrangler deploy`);
  `npm run build` na VPS slúži len lokálnemu gatewayu / dev.
- **CI na push** (GitHub Action): build + deploy, nech to nie je ručné.
- **`/version` endpoint** na porovnanie: hash assetov worker verzie vs. VPS kódu,
  a upozornenie v UI, keď sa líšia.
- Zvážiť odstránenie duplicitného loginu z `worker.js` (nechať len Access).

---

## 5. Pre / proti (rýchle)

| Kritérium | A) Worker + VPC | B) single-origin tunnel | C) B + Access |
|---|---|---|---|
| Počet deploy miest | 2 | 1 | 1 |
| Drift UI/VPS | áno (riziko) | nie | nie |
| Latencia API | edge→tunel→VPS | tunel→VPS | tunel→VPS |
| Edge cache assetov | áno | nie | nie |
| Auth | duplicitne edge+VPS | vlastný login (VPS) | Access (voliteľne) |
| SPOF | VPC tunnel | tunnel | tunnel |
| Zložitosť | vyššia | nižšia | stredná |

---

## 6. Rozhodnutia / otvorené otázky

1. Chceš edge cache assetov? → nie ⇒ **B/C**; áno ⇒ ostať pri **A** + CI.
2. Chceš SSO/MFA a vypnutie vlastného loginu? → **C**.
3. Aká doména? `app.<domena>` (B) vs. súčasný `w.ocu.workers.dev`.
4. Migrovať hneď, alebo len pripraviť a spustiť pri najbližšom prerušení?
5. Zmazať `worker.js`/alias worker, alebo nechať ako fallback?

---

## 7. Acceptance (keď sa bude migrovať)

1. `https://app.<domena>` načíta UI **aj** `/api` z VPS; žiadny worker v ceste.
2. `npm run build` na VPS sa prejaví po reloade (žiadny `wrangler deploy`).
3. Login a session cookie funguje za tunnelom; logout maže cookie.
4. SSE `/api/v2/events` streamuje stabilne (text deltas, run state).
5. Reštart `workbench-console.service` počas behu runu nezabije control plane.
6. Vypnutie/dropnutie VPC/edge častí nerozbije prístup.
7. Cloudflare Access (ak C) vpustí len povolenú identitu.

## 8. Riziká

- **Proxy hlavičky:** `server.js` musí správne rozpoznať `trustedProxy`; zle
  nastavené `x-forwarded-*` môže rozbiť generovanie cookie (`Secure`) alebo
  IP pre rate-limiting.
- **cloudflared ako SPOF:** jedna služba; dať `Restart=always` a monitoring.
- **DNS/verzia cache:** starý `index.html` v prehliadači — držať `no-cache`.
- **Backup:** nezabudnúť, že dáta (`WORKBENCH_DATA`, `~/.local/share/workbench`)
  ostávajú na VPS; migrácia hostingu na nich nič nemení.
