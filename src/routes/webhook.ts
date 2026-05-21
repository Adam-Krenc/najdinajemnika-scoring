import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { scoreApplicant } from "../scoring/claude";
import { generateAd } from "../ads/generateAd";

const router = Router();
const prisma = new PrismaClient();

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
  } catch (err) {
    console.error(`[score] Chyba při scoringu ${applicantId}:`, err);
    // Mark as failed so admin can see it
    await prisma.applicant.update({
      where: { id: applicantId },
      data: { status: "score-error" },
    }).catch(() => {});
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
  } catch (err) {
    console.error(`[ad] Chyba při generování inzerátu ${listingId}:`, err);
    await prisma.listing.update({
      where: { id: listingId },
      data: { adStatus: "error" },
    }).catch(() => {});
  }
});

export { router as webhookRouter };
