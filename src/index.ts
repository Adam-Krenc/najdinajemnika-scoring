import "dotenv/config";
import express from "express";
import cron from "node-cron";
import { webhookRouter } from "./routes/webhook";
import { runMonitor } from "./monitor";
import { timingSafeEqualStr } from "./lib/secret";

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001;

// Neprozrazovat běhové prostředí (Express) — fingerprinting útočníkům.
app.disable("x-powered-by");

// Bezpečnostní HTTP hlavičky pro všechny odpovědi (NIS2 hardening).
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  next();
});

app.use(express.json({ limit: "1mb" }));

// Jednoduchý in-memory rate limiter (per IP) — ztěžuje brute-force WEBHOOK_SECRET
// a hromadné zneužití endpointů. Tvrdou ochranu řešte na úrovni reverse proxy.
const RL_WINDOW_MS = 60_000;
const RL_MAX = 120;
const rlBuckets = new Map<string, { count: number; resetAt: number }>();
app.use((req, res, next) => {
  const ip =
    (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0].trim() ??
    req.socket.remoteAddress ??
    "unknown";
  const now = Date.now();
  const entry = rlBuckets.get(ip);
  if (!entry || now > entry.resetAt) {
    rlBuckets.set(ip, { count: 1, resetAt: now + RL_WINDOW_MS });
  } else {
    entry.count += 1;
    if (entry.count > RL_MAX) {
      res.status(429).json({ error: "Too many requests" });
      return;
    }
  }
  next();
});

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

app.listen(PORT, () => {
  console.log(`[scoring] Server běží na portu ${PORT}`);
  console.log("[monitor] Denní kontrola kreditů naplánována na 8:00 Europe/Prague");
});
