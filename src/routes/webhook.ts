import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { scoreApplicant } from "../scoring/claude";
import { generateAd } from "../ads/generateAd";
import { lookupIsir } from "../isir/lookup";
import { sendIsirResults, sendAdminIsirFallback } from "../isir/email";
import { lookupCee } from "../cee/lookup";

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
      // Complete/Deep: ISIR uložen → automaticky spusť CEE lookup
      console.log(`[isir] ${verification.package} ${verificationId} → ISIR ${result.rawResult}, spouštím CEE`);
      runCeeLookup(verificationId, verification.tenantName, verification.landlordName, verification.landlordEmail, packageLabel).catch(
        (err) => console.error(`[cee] Chyba při auto-spuštění CEE pro ${verificationId}:`, err)
      );
    }
  } catch (err) {
    console.error(`[isir] Chyba při ISIR lookup ${verificationId}:`, err);
    await prisma.verification.update({
      where: { id: verificationId },
      data: { isirResult: "error" },
    }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// CEE lookup — interní async funkce volaná po ISIR i přes manuální webhook
// ---------------------------------------------------------------------------

const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL ?? "https://www.najdinajemnika.cz";

async function sendCeeAdminFallback(params: {
  verificationId: string;
  landlordName: string;
  landlordEmail: string;
  tenantName: string;
  packageLabel: string;
  note?: string;
}) {
  const { verificationId, landlordName, landlordEmail, tenantName, packageLabel, note } = params;
  const adminUrl = `${BASE_URL}/admin/verifications/${verificationId}`;
  const { Resend } = await import("resend");
  const resend = new Resend(RESEND_API_KEY);
  await resend.emails.send({
    from: "NajdiNájemníka.cz <obchod@smartapky.cz>",
    to: "obchod@smartapky.cz",
    subject: `[Ověření – CEE ruční] ${tenantName}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;padding:32px;">
        <h1 style="color:#1a56db;font-size:20px;">CEE kontrola – nutný ruční zásah</h1>
        <p style="color:#374151;">Automatická CEE kontrola selhala nebo není nakonfigurována. Proveďte ručně.</p>
        ${note ? `<p style="background:#fefce8;padding:10px;border-radius:6px;color:#92400e;">${note}</p>` : ""}
        <div style="background:#f9fafb;border-radius:8px;padding:16px;margin:16px 0;">
          <p style="margin:4px 0;"><strong>ID:</strong> ${verificationId}</p>
          <p style="margin:4px 0;"><strong>Balíček:</strong> ${packageLabel}</p>
          <p style="margin:4px 0;"><strong>Pronajímatel:</strong> ${landlordName} (${landlordEmail})</p>
          <p style="margin:4px 0;"><strong>Nájemník:</strong> ${tenantName}</p>
        </div>
        <div style="background:#fefce8;border-radius:8px;padding:12px 16px;margin:16px 0;">
          <p style="margin:0;color:#92400e;font-weight:600;">Zkontrolujte CEE ručně:</p>
          <p style="margin:4px 0;color:#78350f;">• <a href="https://www.ceecr.cz/vyhledavani" style="color:#1a56db;">ceecr.cz/vyhledavani</a></p>
        </div>
        <div style="text-align:center;margin:24px 0;">
          <a href="${adminUrl}" style="background:#1a56db;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-size:15px;font-weight:600;">
            Zadat výsledky v adminu
          </a>
        </div>
      </div>
    `,
  });
}

async function runCeeLookup(
  verificationId: string,
  tenantName: string,
  landlordName: string,
  landlordEmail: string,
  packageLabel: string
) {
  console.log(`[cee] Spouštím CEE lookup pro ${verificationId} (${tenantName})`);

  const result = await lookupCee(tenantName);

  console.log(`[cee] ${tenantName} → ${result.rawResult} (${result.count} exekucí)`);

  if (result.rawResult === "error") {
    // CEE nedostupné → admin musí zkontrolovat ručně
    await prisma.verification.update({
      where: { id: verificationId },
      data: { ceeResult: "error" },
    });
    await sendCeeAdminFallback({
      verificationId,
      landlordName,
      landlordEmail,
      tenantName,
      packageLabel,
      note: result.note,
    });
    console.log(`[cee] CEE error pro ${verificationId} → admin notifikován`);
    return;
  }

  // CEE úspěšně zkontrolováno → auto-complete
  await prisma.verification.update({
    where: { id: verificationId },
    data: {
      ceeResult: result.rawResult,
      status: "complete",
      completedAt: new Date(),
    },
  });

  // Načteme aktuální ISIR výsledek pro finální email pronajímateli
  const verification = await prisma.verification.findUnique({
    where: { id: verificationId },
    select: { isirResult: true, adminNote: true },
  });

  const { Resend } = await import("resend");
  const resend = new Resend(RESEND_API_KEY);

  const RESULT_LABELS: Record<string, string> = {
    clean: "Bez záznamu",
    insolvency_found: "Nalezena insolvence",
    execution_found: "Nalezeny exekuce",
    not_checked: "Nebylo zkontrolováno",
    error: "Nepodařilo se ověřit",
  };

  const isirResult = verification?.isirResult ?? "not_checked";
  const isirLabel = RESULT_LABELS[isirResult] ?? isirResult;
  const ceeLabel = RESULT_LABELS[result.rawResult] ?? result.rawResult;

  const badge = (r: string, label: string) =>
    r === "clean"
      ? `<span style="background:#dcfce7;color:#166534;padding:2px 8px;border-radius:4px;font-size:13px;">✓ ${label}</span>`
      : r === "error"
      ? `<span style="background:#fef9c3;color:#92400e;padding:2px 8px;border-radius:4px;font-size:13px;">⚠ ${label}</span>`
      : `<span style="background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:4px;font-size:13px;">⚠ ${label}</span>`;

  await resend.emails.send({
    from: "NajdiNájemníka.cz <obchod@smartapky.cz>",
    to: landlordEmail,
    subject: `Výsledky prověření nájemníka ${tenantName} – NajdiNájemníka.cz`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;padding:32px;">
        <h1 style="color:#1a56db;font-size:24px;margin-bottom:8px;">Výsledky prověření</h1>
        <p style="color:#374151;font-size:16px;">Dobrý den, ${landlordName},</p>
        <p style="color:#374151;font-size:16px;">
          Prověření nájemníka <strong>${tenantName}</strong> (${packageLabel}) bylo dokončeno.
        </p>
        <div style="background:#f9fafb;border-radius:8px;padding:20px;margin:24px 0;">
          <h2 style="color:#374151;font-size:16px;margin:0 0 12px;">Výsledky kontrol</h2>
          <p style="margin:8px 0;color:#374151;">
            <strong>Insolvenční rejstřík (ISIR):</strong>&nbsp;${badge(isirResult, isirLabel)}
          </p>
          <p style="margin:8px 0;color:#374151;">
            <strong>Centrální evidence exekucí (CEE):</strong>&nbsp;${badge(result.rawResult, ceeLabel)}
          </p>
          ${result.note ? `<p style="margin-top:12px;color:#6b7280;font-size:13px;">${result.note}</p>` : ""}
          ${verification?.adminNote ? `<p style="margin-top:8px;color:#374151;"><strong>Poznámka:</strong> ${verification.adminNote}</p>` : ""}
        </div>
        <p style="color:#6b7280;font-size:13px;">
          Informace vychází z veřejných registrů ke dni prověření. Nenahrazuje právní poradenství. GDPR compliant.
        </p>
        <p style="color:#6b7280;font-size:14px;margin-top:32px;">© 2026 NajdiNájemníka.cz</p>
      </div>
    `,
  });

  console.log(`[cee] Complete/Deep ${verificationId} → complete, email odeslán`);
}

// POST /webhook/cee — manuální spuštění CEE (např. pokud auto-trigger selhal)
router.post("/cee", async (req: Request, res: Response) => {
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

  if (!["pending_check", "complete"].includes(verification.status) && verification.ceeResult !== "error") {
    res.status(409).json({ error: `Neočekávaný status: ${verification.status}` });
    return;
  }

  res.json({ ok: true, message: "CEE lookup spuštěn" });

  const packageLabel = PACKAGE_LABELS[verification.package] ?? verification.package;
  runCeeLookup(
    verificationId,
    verification.tenantName,
    verification.landlordName,
    verification.landlordEmail,
    packageLabel
  ).catch((err) => console.error(`[cee] Chyba při manuálním CEE ${verificationId}:`, err));
});

export { router as webhookRouter };
