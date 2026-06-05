import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { scoreApplicant } from "../scoring/claude";
import { determineScoringStatus } from "../scoring/status";
import { timingSafeEqualStr } from "../lib/secret";
import { generateAd } from "../ads/generateAd";
import { lookupIsir } from "../isir/lookup";
import { sendIsirResults, sendAdminIsirFallback } from "../isir/email";
import { lookupCee } from "../cee/lookup";
import { createReferenceCall, isCallHour } from "../reference/vapi";
import { evaluateReferenceTranscript } from "../reference/evaluate";
import { generateShortlistPdf } from "../pdf/shortlist";
import type { ShortlistApplicant } from "../pdf/shortlist";

const router = Router();
const prisma = new PrismaClient();

function verifySecret(req: Request, res: Response): boolean {
  const header = req.headers["x-webhook-secret"];
  // Hlavička může přijít jako string | string[] | undefined.
  const secret = Array.isArray(header) ? header[0] : header;
  if (!process.env.WEBHOOK_SECRET || !secret || !timingSafeEqualStr(secret, process.env.WEBHOOK_SECRET)) {
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

    const newStatus = determineScoringStatus(result.score);

    await prisma.applicant.update({
      where: { id: applicantId },
      data: {
        score: result.score,
        scoringReason: result.oduvodneni,
        aiNote: result.ai_poznamka,
        vyjimecny: result.vyjimecny ?? false,
        status: newStatus,
      },
    });

    console.log(`[score] Applicant ${applicantId} → score ${result.score} (${result.doporuceni}) → ${newStatus}`);

    // Auto-trigger reference call if applicant passed AI scoring
    if (newStatus === "awaiting_reference") {
      triggerReferenceCallIfPossible(applicantId).catch((err) =>
        console.error(`[score] Chyba při auto-trigger reference ${applicantId}:`, err)
      );
    }
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

// ---------------------------------------------------------------------------
// Reference check — VAPI outbound + AI evaluation
// ---------------------------------------------------------------------------

/**
 * Pokud má uchazeč telefon na předchozího pronajímatele a je pracovní doba,
 * zavolá VAPI outbound call. Jinak nic nedělá (admin může triggernout ručně).
 */
async function triggerReferenceCallIfPossible(applicantId: string) {
  const applicant = await prisma.applicant.findUnique({
    where: { id: applicantId },
    include: { listing: { select: { street: true, city: true } } },
  });

  if (!applicant?.previousLandlordPhone) {
    console.log(`[reference] ${applicantId} nemá previousLandlordPhone — přeskakuji auto-trigger`);
    return;
  }

  if (applicant.referenceAttempts >= 3) {
    console.log(`[reference] ${applicantId} dosáhl max pokusů — přeskakuji`);
    return;
  }

  if (!isCallHour()) {
    console.log(`[reference] ${applicantId} mimo pracovní dobu — auto-trigger přeskočen, admin může zavolat ručně`);
    return;
  }

  const listingAddress = [applicant.listing?.street, applicant.listing?.city]
    .filter(Boolean)
    .join(", ");

  const callResult = await createReferenceCall({
    applicantName: applicant.name,
    landlordPhone: applicant.previousLandlordPhone,
    listingAddress,
  });

  if (!callResult.ok) {
    console.error(`[reference] VAPI selhal pro ${applicantId}: ${callResult.error}`);
    return;
  }

  await prisma.applicant.update({
    where: { id: applicantId },
    data: {
      referenceCallId: callResult.callId,
      referenceAttempts: { increment: 1 },
      referenceLastAttemptAt: new Date(),
      referenceStatus: "calling",
    },
  });

  console.log(`[reference] ${applicantId} → VAPI callId ${callResult.callId}`);
}

/**
 * Zpracuje přepis referenčního hovoru: vyhodnotí Claudem a aktualizuje status.
 * Voláno z main projektu VAPI webhooku přes tento endpoint.
 */
async function handleReferenceTranscript(params: {
  applicantId: string;
  callId: string;
  transcript: string;
  noAnswer: boolean;
}) {
  const { applicantId, callId, transcript, noAnswer } = params;

  const applicant = await prisma.applicant.findUnique({
    where: { id: applicantId },
    select: { id: true, referenceAttempts: true, previousLandlordPhone: true, name: true, listing: { select: { street: true, city: true } } },
  });

  if (!applicant) {
    console.warn(`[reference] Applicant ${applicantId} nenalezen při zpracování přepisu`);
    return;
  }

  if (noAnswer || !transcript.trim()) {
    // Volání nebylo zvednuté — zkusit znovu nebo přejít na SMS fallback
    const attempts = applicant.referenceAttempts;
    console.log(`[reference] ${applicantId} — nezvedl (pokus ${attempts}/3)`);

    if (attempts >= 3) {
      // 3 pokusy vyčerpány → SMS fallback (Twilio) pak status reference_unreachable
      await triggerSmsFallback(applicantId, applicant);
    }
    // Jinak čekáme — admin nebo cron trigger pro další pokus
    return;
  }

  // Hovor proběhl → Claude vyhodnotí přepis
  const evaluation = await evaluateReferenceTranscript(transcript);

  console.log(`[reference] ${applicantId} transcript eval → ${evaluation.result}: ${evaluation.note}`);

  const newStatus =
    evaluation.result === "negative" ? "rejected_reference" : "awaiting_registry_check";

  await prisma.applicant.update({
    where: { id: applicantId },
    data: {
      referenceResult: evaluation.result,
      referenceNote: evaluation.note,
      referenceTranscript: transcript.slice(0, 5000),
      referenceStatus: "done",
      status: newStatus,
    },
  });

  console.log(`[reference] ${applicantId} → ${newStatus}`);

  // Pokud přešel do awaiting_registry_check, zkontroluj auto-trigger registrů
  if (newStatus === "awaiting_registry_check") {
    const listing = await prisma.applicant.findUnique({
      where: { id: applicantId },
      select: { listingId: true },
    });
    if (listing?.listingId) {
      maybeAutoTriggerRegistry(listing.listingId).catch((err) =>
        console.error(`[reference] Auto-trigger registry chyba ${applicantId}:`, err)
      );
    }
  }
}

async function triggerSmsFallback(
  applicantId: string,
  applicant: { previousLandlordPhone: string | null; name: string }
) {
  if (!applicant.previousLandlordPhone) return;

  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioToken = process.env.TWILIO_AUTH_TOKEN;
  const twilioFrom = process.env.TWILIO_PHONE_NUMBER;

  if (!twilioSid || !twilioToken || !twilioFrom) {
    console.warn(`[reference] Twilio není nakonfigurováno — SMS fallback přeskočen pro ${applicantId}`);
    await prisma.applicant.update({
      where: { id: applicantId },
      data: { status: "reference_unreachable" },
    });
    return;
  }

  const smsText =
    `Dobrý den, volali jsme vám ohledně reference na nájemníka ${applicant.name}. ` +
    `Pokud nás chcete kontaktovat, zavolejte prosím na naše číslo nebo odpovězte na tuto zprávu. ` +
    `Děkujeme, NajdiNájemníka.cz`;

  const body = new URLSearchParams({
    From: twilioFrom,
    To: applicant.previousLandlordPhone,
    Body: smsText,
  });

  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${twilioSid}:${twilioToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
        signal: AbortSignal.timeout(10_000),
      }
    );

    if (res.ok) {
      console.log(`[reference] SMS fallback odesláno na ${applicant.previousLandlordPhone}`);
      await prisma.applicant.update({
        where: { id: applicantId },
        data: { referenceStatus: "sms_sent" },
      });
    } else {
      console.error(`[reference] SMS fallback selhal: HTTP ${res.status}`);
      await prisma.applicant.update({
        where: { id: applicantId },
        data: { status: "reference_unreachable" },
      });
    }
  } catch (err) {
    console.error(`[reference] SMS fallback chyba:`, err);
    await prisma.applicant.update({
      where: { id: applicantId },
      data: { status: "reference_unreachable" },
    });
  }
}

// POST /webhook/applicant/reference/call — ručně spustí VAPI outbound call
router.post("/applicant/reference/call", async (req: Request, res: Response) => {
  if (!verifySecret(req, res)) return;

  const { applicantId } = req.body;
  if (!applicantId || typeof applicantId !== "string") {
    res.status(400).json({ error: "Chybí applicantId" });
    return;
  }

  const applicant = await prisma.applicant
    .findUnique({
      where: { id: applicantId },
      include: { listing: { select: { street: true, city: true } } },
    })
    .catch(() => null);

  if (!applicant) {
    res.status(404).json({ error: "Uchazeč nenalezen" });
    return;
  }

  if (!applicant.previousLandlordPhone) {
    res.status(422).json({ error: "Uchazeč nemá zadán telefon na předchozího pronajímatele" });
    return;
  }

  if (applicant.referenceAttempts >= 3) {
    res.status(422).json({ error: "Dosažen maximální počet pokusů (3)" });
    return;
  }

  if (!isCallHour()) {
    res.status(422).json({ error: "Mimo pracovní dobu 9–17. Zkuste v pracovní době." });
    return;
  }

  res.json({ ok: true, message: "Referenční hovor spouštím" });

  const listingAddress = [applicant.listing?.street, applicant.listing?.city]
    .filter(Boolean)
    .join(", ");

  const callResult = await createReferenceCall({
    applicantName: applicant.name,
    landlordPhone: applicant.previousLandlordPhone,
    listingAddress,
  });

  if (!callResult.ok) {
    console.error(`[reference/call] VAPI selhal pro ${applicantId}: ${callResult.error}`);
    return;
  }

  await prisma.applicant.update({
    where: { id: applicantId },
    data: {
      referenceCallId: callResult.callId,
      referenceAttempts: { increment: 1 },
      referenceLastAttemptAt: new Date(),
      referenceStatus: "calling",
    },
  });

  console.log(`[reference/call] ${applicantId} → VAPI callId ${callResult.callId}`);
});

// POST /webhook/applicant/reference/transcript — přijme přepis z main projektu po skončení hovoru
router.post("/applicant/reference/transcript", async (req: Request, res: Response) => {
  if (!verifySecret(req, res)) return;

  const { callId, transcript, noAnswer } = req.body as {
    callId?: string;
    transcript?: string;
    noAnswer?: boolean;
  };

  if (!callId) {
    res.status(400).json({ error: "Chybí callId" });
    return;
  }

  // Najdi applicanta podle callId
  const applicant = await prisma.applicant
    .findFirst({ where: { referenceCallId: callId } })
    .catch(() => null);

  if (!applicant) {
    res.status(404).json({ error: `Žádný uchazeč s referenceCallId = ${callId}` });
    return;
  }

  res.json({ ok: true });

  handleReferenceTranscript({
    applicantId: applicant.id,
    callId,
    transcript: transcript ?? "",
    noAnswer: noAnswer ?? false,
  }).catch((err) =>
    console.error(`[reference/transcript] Chyba ${applicant.id}:`, err)
  );
});

// ---------------------------------------------------------------------------
// Applicant registry check (CEE + ISIR) — nový Applicant pipeline flow
// ---------------------------------------------------------------------------

async function runApplicantRegistryCheck(applicantId: string, tenantName: string) {
  console.log(`[applicant/registry] Spouštím ISIR + CEE pro ${applicantId} (${tenantName})`);

  const [isirRes, ceeRes] = await Promise.all([
    lookupIsir(tenantName),
    lookupCee(tenantName),
  ]);

  console.log(`[applicant/registry] ISIR ${tenantName} → ${isirRes.rawResult}`);
  console.log(`[applicant/registry] CEE  ${tenantName} → ${ceeRes.rawResult}`);

  await prisma.applicant.update({
    where: { id: applicantId },
    data: {
      isirResult: isirRes.rawResult,
      ceeResult: ceeRes.rawResult,
      registryCheckedAt: new Date(),
      status: "registry_check_done",
    },
  });

  console.log(`[applicant/registry] ${applicantId} → registry_check_done`);
}

/**
 * Pokud pro daný listing splníme trigger podmínky (3+ kandidátů nebo výjimečný),
 * spustí registry check pro všechny awaiting_registry_check uchazeče.
 */
export async function maybeAutoTriggerRegistry(listingId: string) {
  const candidates = await prisma.applicant.findMany({
    where: { listingId, status: "awaiting_registry_check" },
    select: { id: true, name: true, vyjimecny: true },
  });

  const shouldTrigger = candidates.length >= 3 || candidates.some((c) => c.vyjimecny);
  if (!shouldTrigger) return;

  console.log(`[applicant/registry] Auto-trigger listing ${listingId}: ${candidates.length} kandidátů`);

  for (const c of candidates) {
    runApplicantRegistryCheck(c.id, c.name).catch((err) =>
      console.error(`[applicant/registry] Auto-trigger chyba ${c.id}:`, err)
    );
  }
}

// POST /webhook/applicant/registry — spustí CEE + ISIR pro jednoho uchazeče
router.post("/applicant/registry", async (req: Request, res: Response) => {
  if (!verifySecret(req, res)) return;

  const { applicantId } = req.body;
  if (!applicantId || typeof applicantId !== "string") {
    res.status(400).json({ error: "Chybí applicantId" });
    return;
  }

  const applicant = await prisma.applicant
    .findUnique({ where: { id: applicantId } })
    .catch(() => null);

  if (!applicant) {
    res.status(404).json({ error: "Uchazeč nenalezen" });
    return;
  }

  res.json({ ok: true, message: "Registry check spuštěn" });

  runApplicantRegistryCheck(applicantId, applicant.name).catch((err) =>
    console.error(`[applicant/registry] Chyba ${applicantId}:`, err)
  );
});

// POST /webhook/applicant/registry-batch — spustí CEE + ISIR pro všechny awaiting_registry_check u listingu
router.post("/applicant/registry-batch", async (req: Request, res: Response) => {
  if (!verifySecret(req, res)) return;

  const { listingId } = req.body;
  if (!listingId || typeof listingId !== "string") {
    res.status(400).json({ error: "Chybí listingId" });
    return;
  }

  const candidates = await prisma.applicant
    .findMany({
      where: { listingId, status: "awaiting_registry_check" },
      select: { id: true, name: true },
    })
    .catch(() => []);

  res.json({ ok: true, count: candidates.length });

  for (const c of candidates) {
    runApplicantRegistryCheck(c.id, c.name).catch((err) =>
      console.error(`[applicant/registry] Batch chyba ${c.id}:`, err)
    );
  }
});

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

// ---------------------------------------------------------------------------
// Shortlist PDF generování a odeslání majiteli
// ---------------------------------------------------------------------------

// POST /webhook/listing/shortlist-pdf — vygeneruje PDF a pošle majiteli
router.post("/listing/shortlist-pdf", async (req: Request, res: Response) => {
  if (!verifySecret(req, res)) return;

  const { listingId } = req.body;
  if (!listingId || typeof listingId !== "string") {
    res.status(400).json({ error: "Chybí listingId" });
    return;
  }

  const listing = await prisma.listing
    .findUnique({
      where: { id: listingId },
      include: {
        owner: { select: { name: true, email: true } },
        applicants: {
          where: { status: { in: ["shortlisted", "registry_check_done"] } },
          orderBy: { score: "desc" },
          take: 5,
        },
      },
    })
    .catch(() => null);

  if (!listing) {
    res.status(404).json({ error: "Listing nenalezen" });
    return;
  }

  if (listing.applicants.length === 0) {
    res.status(422).json({ error: "Žádní shortlistovaní uchazeči pro tento listing" });
    return;
  }

  res.json({ ok: true, count: listing.applicants.length });

  try {
    const applicants: ShortlistApplicant[] = listing.applicants.map((a) => ({
      name: a.name,
      score: a.score ?? 0,
      aiNote: a.aiNote,
      referenceResult: a.referenceResult,
      referenceNote: a.referenceNote,
      isirResult: a.isirResult,
      ceeResult: a.ceeResult,
      income: a.income,
      employment: a.employment,
      personsCount: a.personsCount,
      hasPets: a.hasPets,
      moveReason: a.moveReason,
      email: a.email,
      phone: a.phone,
    }));

    const pdfBuffer = await generateShortlistPdf({
      listingAddress: `${listing.street}, ${listing.city}`,
      ownerName: listing.owner.name ?? "Majitel",
      generatedAt: new Date(),
      applicants,
    });

    await sendShortlistEmail({
      ownerEmail: listing.owner.email,
      ownerName: listing.owner.name ?? "Majitel",
      listingAddress: `${listing.street}, ${listing.city}`,
      applicantCount: applicants.length,
      pdfBuffer,
    });

    console.log(`[shortlist-pdf] Listing ${listingId} → PDF odesláno na ${listing.owner.email}`);
  } catch (err) {
    console.error(`[shortlist-pdf] Chyba pro ${listingId}:`, err);
  }
});

async function sendShortlistEmail(params: {
  ownerEmail: string;
  ownerName: string;
  listingAddress: string;
  applicantCount: number;
  pdfBuffer: Buffer;
}) {
  const { ownerEmail, ownerName, listingAddress, applicantCount, pdfBuffer } = params;
  const { Resend } = await import("resend");
  const resend = new Resend(process.env.RESEND_API_KEY ?? "");

  await resend.emails.send({
    from: "NajdiNájemníka.cz <obchod@smartapky.cz>",
    to: ownerEmail,
    subject: `Shortlist uchazečů pro ${listingAddress} – NajdiNájemníka.cz`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;padding:32px;">
        <h1 style="color:#1a56db;font-size:24px;margin-bottom:8px;">Váš shortlist je připraven!</h1>
        <p style="color:#374151;font-size:16px;">Dobrý den, ${ownerName},</p>
        <p style="color:#374151;font-size:16px;">
          Prošli jsme všechny uchazeče o byt <strong>${listingAddress}</strong> a v příloze najdete
          shortlist <strong>${applicantCount} nejlepších kandidátů</strong> seřazených od nejlepšího.
        </p>
        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;margin:24px 0;">
          <p style="margin:0;color:#166534;font-weight:600;">Co obsahuje shortlist:</p>
          <ul style="margin:8px 0 0;padding-left:20px;color:#166534;">
            <li>AI hodnocení a poznámka ke každému kandidátovi</li>
            <li>Výsledek referenčního hovoru s předchozím pronajímatelem</li>
            <li>Výsledky kontroly ISIR a CEE (registry exekucí a insolvencí)</li>
            <li>Kontaktní údaje pro přímé oslovení</li>
          </ul>
        </div>
        <p style="color:#374151;font-size:16px;">
          Doporučujeme začít s prvním kandidátem na seznamu a v případě zájmu ho kontaktovat přímo.
        </p>
        <p style="color:#6b7280;font-size:13px;">
          Máte dotaz? Napište nám na
          <a href="mailto:obchod@smartapky.cz" style="color:#1a56db;">obchod@smartapky.cz</a>
        </p>
        <p style="color:#6b7280;font-size:14px;margin-top:32px;">© 2026 NajdiNájemníka.cz</p>
      </div>
    `,
    attachments: [
      {
        filename: `shortlist-${listingAddress.replace(/[^a-z0-9]/gi, "-").toLowerCase()}.pdf`,
        content: pdfBuffer.toString("base64"),
        contentType: "application/pdf",
      },
    ],
  });
}

export { router as webhookRouter };
