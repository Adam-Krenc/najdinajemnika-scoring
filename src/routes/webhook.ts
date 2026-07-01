import { Router, Request, Response } from "express";
import { createHmac, timingSafeEqual } from "crypto";
import { PrismaClient } from "@prisma/client";
import { scoreApplicant } from "../scoring/claude";
import { determineScoringStatus } from "../scoring/status";
import { timingSafeEqualStr } from "../lib/secret";
import { generateAd } from "../ads/generateAd";
import { lookupIsir } from "../isir/lookup";
import { sendIsirResults, sendAdminIsirFallback } from "../isir/email";
import { lookupCee } from "../cee/lookup";
import { Resend } from "resend";
import { createReferenceCall, parsePostCallTranscript } from "../reference/elevenlabs";
import { isCallHour } from "../reference/callHours";
import { evaluateReferenceTranscript } from "../reference/evaluate";
import { judgeFinalist } from "../reference/finalJudge";
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

/**
 * Ověří HMAC podpis post-call webhooku z ElevenLabs.
 * Hlavička: `ElevenLabs-Signature: t=<unix>,v0=<hex hmac>`
 * Hash = HMAC-SHA256(ELEVENLABS_WEBHOOK_SECRET, `${t}.${rawBody}`).
 * Vyžaduje syrové tělo (req.rawBody — nastaveno v express.json verify callbacku).
 */
function verifyElevenLabsSignature(req: Request): boolean {
  const secret = process.env.ELEVENLABS_WEBHOOK_SECRET;
  if (!secret) return false;

  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!raw) return false;

  const headerVal = req.headers["elevenlabs-signature"];
  const sig = Array.isArray(headerVal) ? headerVal[0] : headerVal;
  if (!sig) return false;

  const parts = Object.fromEntries(
    sig.split(",").map((kv) => {
      const [k, v] = kv.split("=");
      return [k, v];
    })
  );
  const timestamp = parts["t"];
  const provided = parts["v0"];
  if (!timestamp || !provided) return false;

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${raw.toString("utf8")}`)
    .digest("hex");

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
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
// Reference check — ElevenLabs outbound + AI evaluation
// ---------------------------------------------------------------------------

/**
 * Pokud má uchazeč telefon na předchozího pronajímatele a je pracovní doba,
 * zavolá ElevenLabs outbound hovor. Jinak nic nedělá (admin může triggernout ručně).
 *
 * Exportováno i pro recovery sweeper (`scoring/recover.ts`), aby zachráněný
 * uchazeč pokračoval v pipeline stejně jako přes živý `/webhook/score`.
 */
export async function triggerReferenceCallIfPossible(applicantId: string) {
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
    console.error(`[reference] ElevenLabs selhal pro ${applicantId}: ${callResult.error}`);
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

  console.log(`[reference] ${applicantId} → ElevenLabs callId ${callResult.callId}`);
}

/**
 * Zpracuje přepis referenčního hovoru: vyhodnotí Claudem a aktualizuje status.
 * Voláno z main projektu (webhook) přes tento endpoint.
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
    // Volání nebylo zvednuté — zkusit znovu, po 3 pokusech reference jako MĚKKÝ signál.
    const attempts = applicant.referenceAttempts;
    console.log(`[reference] ${applicantId} — nezvedl (pokus ${attempts}/3)`);

    if (attempts >= 3) {
      // 3 pokusy vyčerpány → SMS fallback (Twilio), reference označíme jako nedostupnou,
      // ALE kaskáda pokračuje do registry (reference není tvrdá podmínka — viz design).
      await triggerSmsFallback(applicantId, applicant);
      await prisma.applicant.update({
        where: { id: applicantId },
        data: { referenceStatus: "unreachable", status: "awaiting_registry_check" },
      });
      console.log(`[reference] ${applicantId} → reference nedostupná, pokračuji do registry (měkký signál)`);
      await runApplicantRegistryCheck(applicantId, applicant.name).catch((err) =>
        console.error(`[reference] Registry po nedostupné referenci selhal ${applicantId}:`, err)
      );
    }
    // Jinak čekáme — admin nebo cron trigger pro další pokus
    return;
  }

  // Hovor proběhl → Claude vyhodnotí přepis
  const evaluation = await evaluateReferenceTranscript(transcript);

  console.log(`[reference] ${applicantId} transcript eval → ${evaluation.result}: ${evaluation.note}`);

  // Negativní reference = tvrdé zastavení kaskády. Pozitivní/neutrální → pokračuj do registry.
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

  // Pozitivní/neutrální reference → rovnou spusť registry pro tohoto uchazeče (kaskáda per-uchazeč).
  if (newStatus === "awaiting_registry_check") {
    await runApplicantRegistryCheck(applicantId, applicant.name).catch((err) =>
      console.error(`[reference] Registry po referenci selhal ${applicantId}:`, err)
    );
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

// POST /webhook/applicant/reference/call — ručně spustí ElevenLabs outbound hovor
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
    console.error(`[reference/call] ElevenLabs selhal pro ${applicantId}: ${callResult.error}`);
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

  console.log(`[reference/call] ${applicantId} → ElevenLabs callId ${callResult.callId}`);
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

// POST /webhook/elevenlabs/post-call — post-call webhook z ElevenLabs Conversational AI.
// ElevenLabs po skončení reference hovoru pošle data hovoru sem. Mapujeme
// conversation_id → Applicant.referenceCallId a předáme přepis k vyhodnocení.
// Volitelné HMAC ověření přes ELEVENLABS_WEBHOOK_SECRET (enforce jen když je nastaven,
// aby se živá linka nerozbila během nastavování na obou stranách).
router.post("/elevenlabs/post-call", async (req: Request, res: Response) => {
  if (process.env.ELEVENLABS_WEBHOOK_SECRET && !verifyElevenLabsSignature(req)) {
    console.warn("[elevenlabs] Neplatný podpis post-call webhooku — odmítnuto");
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // ElevenLabs obaluje payload do { type, event_timestamp, data: {...} }.
  const envelope = req.body as { data?: Record<string, unknown> };
  const payload = (envelope?.data ?? req.body) as {
    conversation_id?: string;
    transcript?: Array<{ role?: string; message?: string | null }>;
    metadata?: { call_duration_secs?: number };
    status?: string;
  };

  const conversationId = payload?.conversation_id;
  if (!conversationId) {
    res.status(400).json({ error: "Chybí conversation_id" });
    return;
  }

  const applicant = await prisma.applicant
    .findFirst({ where: { referenceCallId: conversationId } })
    .catch(() => null);

  if (!applicant) {
    res.status(404).json({ error: `Žádný uchazeč s referenceCallId = ${conversationId}` });
    return;
  }

  res.json({ ok: true });

  const { transcript, noAnswer } = parsePostCallTranscript(payload);

  handleReferenceTranscript({
    applicantId: applicant.id,
    callId: conversationId,
    transcript,
    noAnswer,
  }).catch((err) => console.error(`[elevenlabs/post-call] Chyba ${applicant.id}:`, err));
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

  // Konec kaskády → finální AI soudce rozhodne ultra_wow / wow / reject.
  await judgeAndRouteFinalist(applicantId).catch((err) =>
    console.error(`[finalJudge] Směrování finalisty selhalo ${applicantId}:`, err)
  );
}

// ---------------------------------------------------------------------------
// Finální AI soudce + doručení finalistů (konec kaskády)
// ---------------------------------------------------------------------------

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "obchod@smartapky.cz";
const ADMIN_BASE_URL = process.env.NEXT_PUBLIC_BASE_URL ?? "https://www.najdinajemnika.cz";
const WOW_BATCH_SIZE = 3; // dávka "wow" se uvolní při tomto počtu...
const WOW_MAX_WAIT_DAYS = 14; // ...nebo po tolika dnech od prvního wow.

/**
 * Spustí finálního AI soudce nad kompletním profilem uchazeče a podle verdiktu
 * ho nasměruje: ultra_wow → ihned k adminovi (finalist_ready), wow → do dávky
 * (finalist_wow), reject → rejected_final.
 */
async function judgeAndRouteFinalist(applicantId: string) {
  const a = await prisma.applicant.findUnique({
    where: { id: applicantId },
    include: { listing: { select: { rent: true, city: true } } },
  });
  if (!a) return;

  const referenceReachable = a.referenceStatus === "done";

  const judgement = await judgeFinalist({
    name: a.name,
    score: a.score,
    scoringReason: a.scoringReason,
    aiNote: a.aiNote,
    income: a.income,
    employment: a.employment,
    personsCount: a.personsCount,
    hasPets: a.hasPets,
    pets: a.pets,
    moveReason: a.moveReason,
    additionalComment: a.additionalComment,
    hasExecutions: a.hasExecutions,
    hasInsolvency: a.hasInsolvency,
    referenceResult: a.referenceResult,
    referenceNote: a.referenceNote,
    referenceReachable,
    isirResult: a.isirResult,
    ceeResult: a.ceeResult,
    rent: a.listing?.rent ?? null,
    city: a.listing?.city ?? null,
  });

  const status =
    judgement.verdict === "reject"
      ? "rejected_final"
      : judgement.verdict === "ultra_wow"
      ? "finalist_ready" // ultra-wow jde k adminovi okamžitě
      : "finalist_wow"; // wow čeká na dávku

  await prisma.applicant.update({
    where: { id: applicantId },
    data: {
      finalVerdict: judgement.verdict,
      finalReason: judgement.reason,
      finalJudgedAt: new Date(),
      status,
    },
  });

  console.log(`[finalJudge] ${applicantId} → ${judgement.verdict} → ${status} (${judgement.reason})`);

  if (judgement.verdict === "ultra_wow") {
    await notifyAdminFinalists(a.listingId, "ultra_wow").catch((err) =>
      console.error(`[finalJudge] Admin notify (ultra) selhal ${applicantId}:`, err)
    );
  } else if (judgement.verdict === "wow") {
    await maybeReleaseWowBatch(a.listingId).catch((err) =>
      console.error(`[finalJudge] Uvolnění dávky selhalo ${a.listingId}:`, err)
    );
  }
}

/**
 * Uvolní dávku "wow" finalistů pro daný listing, pokud je jich dost (WOW_BATCH_SIZE)
 * nebo od prvního wow uplynulo příliš dní (WOW_MAX_WAIT_DAYS). Exportováno kvůli cronu.
 */
export async function maybeReleaseWowBatch(listingId: string) {
  const wowList = await prisma.applicant.findMany({
    where: { listingId, status: "finalist_wow" },
    select: { id: true, finalJudgedAt: true },
    orderBy: { finalJudgedAt: "asc" },
  });

  if (wowList.length === 0) return;

  const oldest = wowList[0].finalJudgedAt;
  const ageDays = oldest ? (Date.now() - oldest.getTime()) / 86_400_000 : 0;
  const release = wowList.length >= WOW_BATCH_SIZE || ageDays >= WOW_MAX_WAIT_DAYS;
  if (!release) return;

  await prisma.applicant.updateMany({
    where: { listingId, status: "finalist_wow" },
    data: { status: "finalist_ready" },
  });

  console.log(
    `[finalJudge] Listing ${listingId}: uvolněna dávka ${wowList.length} wow finalistů (stáří ${ageDays.toFixed(1)} dní)`
  );

  await notifyAdminFinalists(listingId, "wow").catch((err) =>
    console.error(`[finalJudge] Admin notify (dávka) selhal ${listingId}:`, err)
  );
}

/**
 * Projde všechny listingy s čekajícími "wow" finalisty a uvolní ty, kterým vypršela
 * 14denní lhůta (nebo nasbírali dávku). Volá se z cronu v index.ts.
 */
export async function sweepWowBatches(): Promise<{ listings: number }> {
  const rows = await prisma.applicant.findMany({
    where: { status: "finalist_wow" },
    select: { listingId: true },
    distinct: ["listingId"],
  });
  for (const r of rows) {
    await maybeReleaseWowBatch(r.listingId).catch((err) =>
      console.error(`[finalJudge] sweep wow dávky selhal ${r.listingId}:`, err)
    );
  }
  return { listings: rows.length };
}

const finalistResend = new Resend(process.env.RESEND_API_KEY);

/** Pošle adminovi notifikaci, že pro listing jsou připravení finalisté k náhledu a shortlistu. */
async function notifyAdminFinalists(listingId: string, kind: "ultra_wow" | "wow") {
  const ready = await prisma.applicant.findMany({
    where: { listingId, status: "finalist_ready" },
    select: { name: true, finalVerdict: true, finalReason: true },
  });
  if (ready.length === 0) return;

  const listing = await prisma.applicant.findFirst({
    where: { listingId },
    select: { listing: { select: { street: true, city: true } } },
  });
  const addr = [listing?.listing?.street, listing?.listing?.city].filter(Boolean).join(", ");
  const label = kind === "ultra_wow" ? "ULTRA WOW (okamžitě)" : "WOW dávka";
  const adminUrl = `${ADMIN_BASE_URL}/admin`;

  const rows = ready
    .map(
      (r) =>
        `<li><strong>${r.name}</strong> — ${r.finalVerdict ?? ""}: ${r.finalReason ?? ""}</li>`
    )
    .join("");

  await finalistResend.emails.send({
    from: "NajdiNájemníka.cz <obchod@smartapky.cz>",
    to: ADMIN_EMAIL,
    subject: `[Finalisté – ${label}] ${addr || listingId}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
        <h2 style="color:#1a56db;">Připravení finalisté k náhledu</h2>
        <p>Pro byt <strong>${addr || listingId}</strong> jsou prověření finalisté (${label}):</p>
        <ul>${rows}</ul>
        <p style="margin-top:16px;">Zkontrolujte v adminu a spusťte platbu shortlistu majiteli:</p>
        <p><a href="${adminUrl}" style="color:#1a56db;">Otevřít admin →</a></p>
      </div>
    `,
  });

  console.log(`[finalJudge] Admin notifikován (${kind}) pro listing ${listingId}: ${ready.length} finalistů`);
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
          where: { status: { in: ["finalist_ready", "shortlisted", "registry_check_done"] } },
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
