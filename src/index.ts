import "dotenv/config";
import express from "express";
import { webhookRouter } from "./routes/webhook";

// Validate required env vars at startup
const REQUIRED_ENV = ["ANTHROPIC_API_KEY", "DATABASE_URL", "WEBHOOK_SECRET"] as const;
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`[scoring] Chybí povinné env proměnné: ${missing.join(", ")}`);
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001;

app.use(express.json({ limit: "1mb" }));

// Health check
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "najdinajemnika-scoring", ts: new Date().toISOString() });
});

// Webhook routes
app.use("/webhook", webhookRouter);

app.listen(PORT, () => {
  console.log(`[scoring] Server běží na portu ${PORT}`);
});
