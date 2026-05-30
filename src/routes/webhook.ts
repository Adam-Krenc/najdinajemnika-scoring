import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { scoreApplicant } from "../scoring/claude";
import { generateAd } from "../ads/generateAd";
import { lookupIsir } from "../isir/lookup";
import { sendIsirResults, sendAdminIsirFallback } from "../isir/email";

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

const PACKAGE_LABELS: Record<string, string> = {
  basic: "Základní (ISIR)",
  complete: "Kompletní (ISIR + CEE)",
  deep: "Hloubkové prověření",
};

// POST /webhook/isir — automatická ISIR kontrola po souhlasu nájemníka
router.post("/isir", async (req: Request, res: Response) => {
  if (!verifySecret(req, res)) return;

  const { verificationId } = req.body;

  if (!verificationId || typeof verificationId !== "string") {
    res.status(400).json({ error: "Chybí verificationId" });
    return;
  }

  const verification = await prisma.verification.findUnique({
    where: { id: verificationId },
  }).catch(() => null);

  if (!verification) {
    res.status(404).json({ error: "Verifikace nenalezena" });
    return;
  }

  if (verification.status !== "pending_check") {
    res.status(409).json({ error: `Neočekávaný status: ${verification.status}` });
    return;
  }

  console.log(`[isir] Spouštím ISIR lookup pro verification ${verificationId} (${verification.tenantName})`);

  // Odpovědět okamžitě — ISIR lookup běží async
  res.json({ ok: true, message: "ISIR lookup spuštěn" });

  try {
    const result = await lookupIsir(verification.tenantName);

    console.log(`[isir] ${verification.tenantName} → ${result.rawResult} (${result.count} záznamů)`);

    const isBasic = verification.package === "basic";
    const packageLabel = PACKAGE_LABELS[verification.package] ?? verification.package;

    if (result.rawResult === "error") {
      // ISIR nedostupný (pravděpodobně blokace VPS IP) → admin musí zkontrolovat ručně
      await prisma.verification.update({
        where: { id: verificationId },
        data: { isirResult: "error" },
      });
      await sendAdminIsirFallback({
        verificationId,
        landlordName: verification.landlordName,
        landlordEmail: verification.landlordEmail,
        tenantName: verification.tenantName,
        tenantEmail: verification.tenantEmail,
        packageLabel,
        isirNote: result.note,
      });
      console.log(`[isir] ISIR error pro ${verificationId} → admin notifikován`);
      return;
    }

    // ISIR úspěšně zkontrolován
    await prisma.verification.update({
      where: { id: verificationId },
      data: {
        isirResult: result.rawResult,
        ...(isBasic && {
          status: "complete",
          completedAt: new Date(),
        }),
      },
    });

    if (isBasic) {
      // Basic: auto-complete → výsledky rovnou pronajímateli
      await sendIsirResults({
        landlordName: verification.landlordName,
        landlordEmail: verification.landlordEmail,
        tenantName: verification.tenantName,
        isirResult: result.rawResult,
        note: result.note ?? null,
        packageLabel,
      });
      console.log(`[isir] Basic ${verificationId} → complete (${result.rawResult}), email odeslán`);
    } else {
      // Complete/Deep: ISIR uložen, admin dokončí CEE
      console.log(`[isir] ${verification.package} ${verificationId} → ISIR ${result.rawResult}, čeká na CEE`);
    }
  } catch (err) {
    console.error(`[isir] Chyba při ISIR lookup ${verificationId}:`, err);
    await prisma.verification.update({
      where: { id: verificationId },
      data: { isirResult: "error" },
    }).catch(() => {});
  }
});

export { router as webhookRouter };
