import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { scoreApplicant } from "../scoring/claude";
import { generateAd } from "../ads/generateAd";

const router = Router();
const prisma = new PrismaClient();

const NEXTJS_URL = process.env.NEXTJS_WEBHOOK_URL;
const NEXTJS_SECRET = process.env.NEXTJS_WEBHOOK_SECRET;

async function notifyWeb(path: string, body: Record<string, unknown>): Promise<void> {
  if (!NEXTJS_URL || !NEXTJS_SECRET) return;
  try {
    await fetch(`${NEXTJS_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-webhook-secret": NEXTJS_SECRET },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(`[notify] Nepodařilo se notifikovat web (${path}):`, (err as Error).message);
  }
}

function verifySecret(req: Request, res: Response): boolean {
  const secret = req.headers["x-webhook-secret"];
  if (!process.env.WEBHOOK_SECRET || secret !== process.env.WEBHOOK_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

// POST /webhook/score — score an applicant
router.post("/score", async (req: Request, res: Response) => {
  if (!verifySecret(req, res)) return;

  const { applicantId, applicantData, listingData } = req.body;

  if (!applicantId || !applicantData || !listingData) {
    res.status(400).json({ error: "Chybí povinná pole" });
    return;
  }

  console.log(`[score] Spouštím scoring pro applicant ${applicantId}`);

  // Respond immediately — scoring runs async
  res.json({ ok: true, message: "Scoring spuštěn" });

  try {
    const result = await scoreApplicant({
      listing: listingData,
      applicant: applicantData,
    });

    await prisma.applicant.update({
      where: { id: applicantId },
      data: {
        score: result.score,
        scoringReason: result.oduvodneni,
        status: "scored",
      },
    });

    console.log(`[score] Applicant ${applicantId} → score ${result.score} (${result.doporuceni})`);

    await notifyWeb("/api/webhooks/score", {
      applicantId,
      score: result.score,
      doporuceni: result.doporuceni,
      oduvodneni: result.oduvodneni,
      rizika: result.rizika,
      silne_stranky: result.silne_stranky,
    });
  } catch (err) {
    console.error(`[score] Chyba při scoringu ${applicantId}:`, (err as Error).message);
    await prisma.applicant.update({
      where: { id: applicantId },
      data: { status: "score-error" },
    }).catch((dbErr: Error) => console.error(`[score] DB fallback chyba:`, dbErr.message));
  }
});

// POST /webhook/generate-ad — generate listing ad copy
router.post("/generate-ad", async (req: Request, res: Response) => {
  if (!verifySecret(req, res)) return;

  const { listingId, listingData } = req.body;

  if (!listingId || !listingData) {
    res.status(400).json({ error: "Chybí povinná pole" });
    return;
  }

  console.log(`[ad] Generuji inzerát pro listing ${listingId}`);

  // Respond immediately — generation runs async
  res.json({ ok: true, message: "Generování spuštěno" });

  // Mark as generating
  await prisma.listing.update({
    where: { id: listingId },
    data: { adStatus: "generating" },
  }).catch(() => {});

  try {
    const result = await generateAd({ listing: listingData });

    await prisma.listing.update({
      where: { id: listingId },
      data: {
        adHeadline: result.headline,
        adText: result.text,
        adStatus: "ready",
      },
    });

    console.log(`[ad] Listing ${listingId} → inzerát vygenerován: "${result.headline}"`);

    await notifyWeb("/api/webhooks/ad", {
      listingId,
      adHeadline: result.headline,
      adText: result.text,
    });
  } catch (err) {
    console.error(`[ad] Chyba při generování inzerátu ${listingId}:`, (err as Error).message);
    await prisma.listing.update({
      where: { id: listingId },
      data: { adStatus: "error" },
    }).catch((dbErr: Error) => console.error(`[ad] DB fallback chyba:`, dbErr.message));
  }
});

export { router as webhookRouter };
