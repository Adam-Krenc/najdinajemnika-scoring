# najdinajemnika-scoring

AI scoring + prověřování + generování inzerátů — mikroservis pro **NajdiNájemníka.cz**.
Běží odděleně od Next.js webu (na VPS), komunikuje přes webhooky chráněné sdíleným tajemstvím.

## Co služba dělá

- **AI scoring uchazečů** (Claude Sonnet) — vyhodnotí přihlášku, přidělí skóre 0–100, doporučení a poznámku pro majitele
- **Prověření v registrech** — ISIR (insolvence, web scraping) + CEE (exekuce, oficiální API)
- **Reference** — outbound VAPI hovor předchozímu pronajímateli + AI vyhodnocení přepisu (Claude Haiku), SMS fallback přes Twilio
- **Generování inzerátu** (Claude) po zaplacení rezervace
- **Shortlist PDF** — pdfkit dokument s nejlepšími kandidáty, odeslaný majiteli e-mailem

## Spuštění

```bash
npm install
npm run generate     # prisma generate (Prisma client)
npm run dev          # tsx watch — vývoj
npm run build        # tsc → dist/
npm start            # node dist/index.js — produkce
npm test             # node:test (žádný extra framework)
```

Server poslouchá na `PORT` (default **3001**). Health check: `GET /health`.

## Env proměnné

| Proměnná | Účel |
|----------|------|
| `WEBHOOK_SECRET` | Sdílené tajemství — ověřuje všechny příchozí webhooky (hlavička `x-webhook-secret`) |
| `ANTHROPIC_API_KEY` | Claude (scoring, reference eval, ad generation) |
| `CEE_API_KEY`, `CEE_API_SECRET` | CEE API (ceecr.cz) — exekuce |
| `VAPI_API_KEY`, `VAPI_REFERENCE_ASSISTANT_ID`, `VAPI_PHONE_NUMBER_ID` | VAPI outbound reference hovory |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` | SMS fallback reference |
| `RESEND_API_KEY` | Odesílání e-mailů (shortlist, ISIR výsledky) |
| `NEXT_PUBLIC_BASE_URL` | Základ URL webu (odkazy v e-mailech) |
| `PORT` | Port serveru (default 3001) |
| `DATABASE_URL` | Postgres (Prisma) — sdílená DB s webem |

## Endpointy (vše `POST`, prefix `/webhook`, hlavička `x-webhook-secret`)

| Endpoint | Co dělá |
|----------|---------|
| `/score` | Naskóruje uchazeče. Odpoví 200 hned, scoring běží async. score ≥ 50 → `awaiting_reference`, jinak `rejected_ai` |
| `/generate-ad` | Vygeneruje text inzerátu pro listing |
| `/isir` | Spustí ISIR check pro verification (produkt B) |
| `/cee` | Spustí CEE check pro verification |
| `/applicant/registry` | CEE + ISIR pro jednoho uchazeče |
| `/applicant/registry-batch` | CEE + ISIR pro celý listing |
| `/applicant/reference/call` | Outbound VAPI reference hovor |
| `/applicant/reference/transcript` | Přijme přepis, AI vyhodnotí, aktualizuje status |
| `/listing/shortlist-pdf` | Vygeneruje shortlist PDF a pošle majiteli |

## Pipeline statusy uchazeče

```
new → scored → rejected_ai
                          ↘
             awaiting_reference → rejected_reference
                               ↘  reference_unreachable
                    awaiting_registry_check → registry_check_done → shortlisted
                                                                  ↘ rejected_final
```

Skóre práh (`SCORE_THRESHOLD`) je **50** — viz `src/scoring/status.ts`.

## Struktura

```
src/
  index.ts              Express server + mount routeru
  routes/webhook.ts     Všechny webhook handlery
  scoring/
    prompt.ts           System prompt + buildScoringPrompt (čistá fce)
    claude.ts           scoreApplicant + extractJSON/parseScoringResponse (čisté fce)
    status.ts           determineScoringStatus + SCORE_THRESHOLD
  reference/
    vapi.ts             Outbound hovor + isCallHour/isWithinCallHours
    evaluate.ts         AI vyhodnocení přepisu reference
  cee/lookup.ts         CEE API (exekuce) + splitName
  isir/lookup.ts        ISIR scraping (insolvence) + parseIsirResults/isErrorPage
  pdf/shortlist.ts      Generátor shortlist PDF
  ads/                  Generování inzerátu
  lib/secret.ts         timingSafeEqualStr (ověření webhook tajemství)
  __tests__/            node:test (49 testů — čisté funkce)
```

## Testy

Používá vestavěný `node:test` přes `tsx` (žádný Jest/Vitest). Testují se **čisté funkce**
(parsování, scoring práh, prompt builder, timing-safe compare) — bez síťových volání a DB.

```bash
npm test
```

## Bezpečnost & robustnost

Viz `../najdinajemnika/docs/WEBHOOK_AUDIT.md` (audit webhooků hlavního i tohoto projektu).
Známé zbývající body: perzistentní retry triggerů (P1) a recovery sweeper pro uvízlé `new` (P2).
