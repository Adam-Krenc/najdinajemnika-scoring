import "dotenv/config";
import express from "express";
import cron from "node-cron";
import { webhookRouter, sweepWowBatches } from "./routes/webhook";
import { runMonitor } from "./monitor";
import { recoverStuckApplicants } from "./scoring/recover";
import { timingSafeEqualStr } from "./lib/secret";

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001;

app.use(
  express.json({
    limit: "1mb",
    // Zachová syrové tělo pro HMAC ověření webhooků (ElevenLabs post-call).
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    },
  })
);

// Health check
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "najdinajemnika-scoring", ts: new Date().toISOString() });
});

// Webhook routes
app.use("/webhook", webhookRouter);

// Manuální spuštění monitoringu (test) — chráněno WEBHOOK_SECRET.
// POST /monitor/run?vapi=1  s hlavičkou x-webhook-secret
app.post("/monitor/run", async (req, res) => {
  const header = req.headers["x-webhook-secret"];
  const secret = Array.isArray(header) ? header[0] : header;
  if (!process.env.WEBHOOK_SECRET || !secret || !timingSafeEqualStr(secret, process.env.WEBHOOK_SECRET)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const includeVapi = req.query.vapi === "1";
  const message = await runMonitor(includeVapi);
  res.json({ ok: true, message });
});

// Manuální spuštění scoring recovery sweeperu (test/ops) — chráněno WEBHOOK_SECRET.
// POST /recover/run?minutes=10  s hlavičkou x-webhook-secret
app.post("/recover/run", async (req, res) => {
  const header = req.headers["x-webhook-secret"];
  const secret = Array.isArray(header) ? header[0] : header;
  if (!process.env.WEBHOOK_SECRET || !secret || !timingSafeEqualStr(secret, process.env.WEBHOOK_SECRET)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const minutes = req.query.minutes ? parseInt(req.query.minutes as string) : undefined;
  const summary = await recoverStuckApplicants({ olderThanMinutes: minutes });
  res.json({ ok: true, ...summary });
});

// Je v Praze pondělí? (kvůli týdenní připomínce Vapi)
function isMondayInPrague(): boolean {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Prague",
    weekday: "short",
  }).format(new Date());
  return weekday === "Mon";
}

// Denní přehled kreditů — každý den v 8:00 Europe/Prague.
// V pondělí navíc týdenní připomínka ruční kontroly Vapi.
cron.schedule(
  "0 8 * * *",
  () => {
    console.log("[monitor] Spouštím denní kontrolu kreditů");
    runMonitor(isMondayInPrague()).catch((err) => console.error("[monitor] Selhalo:", err));
  },
  { timezone: "Europe/Prague" }
);

// Scoring recovery sweeper — každých 10 minut (audit P1 + P2).
// Najde uchazeče uvízlé ve stavu "new" (ztracený trigger / pád procesu) a přescóruje je.
cron.schedule("*/10 * * * *", () => {
  recoverStuckApplicants()
    .then((s) => {
      if (s.found > 0) {
        console.log(`[recover] Sweep hotov: nalezeno ${s.found}, zachráněno ${s.scored}, selhalo ${s.failed}`);
      }
    })
    .catch((err) => console.error("[recover] Sweep selhal:", err));
});

// Uvolnění "wow" dávek finalistů — každých 6 hodin zkontroluj 14denní lhůtu.
cron.schedule("0 */6 * * *", () => {
  sweepWowBatches()
    .then((s) => {
      if (s.listings > 0) console.log(`[finalJudge] Wow sweep: zkontrolováno ${s.listings} listingů`);
    })
    .catch((err) => console.error("[finalJudge] Wow sweep selhal:", err));
});

app.listen(PORT, () => {
  console.log(`[scoring] Server běží na portu ${PORT}`);
  console.log("[monitor] Denní kontrola kreditů naplánována na 8:00 Europe/Prague");
  console.log("[recover] Scoring recovery sweeper naplánován každých 10 minut");
});
