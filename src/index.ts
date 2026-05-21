import "dotenv/config";
import express from "express";
import { webhookRouter } from "./routes/webhook";

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
