/**
 * Recovery sweeper pro AI scoring (audit nálezy P1 + P2).
 *
 * Proč existuje:
 *  - P1: trigger `/webhook/score` z hlavní app je fire-and-forget. Když je VPS
 *    při odeslání dotazníku nedostupná, volání tiše selže a uchazeč navždy uvízne
 *    ve stavu `new` (scoring se nikdy nespustí).
 *  - P2: scoring běží async po odeslání HTTP 200. Když proces spadne (deploy, OOM,
 *    restart) mezi 200 a dokončením, uchazeč také uvízne ve `new`.
 *
 * Oba scénáře řeší jeden periodický sweep: najdi uchazeče ve `new` starší než
 * `olderThanMinutes` a přescóruj je. Scoring je idempotentní (čte aktuální data,
 * přepíše skóre a status), takže opakování je bezpečné.
 *
 * Záměrně se NEdotýká `score-error` — to je stav vědomě vystavený adminovi
 * (aplikační chyba scoringu, ne ztracený trigger). Opakované přescórování vadné
 * přihlášky by mohlo nekonečně cyklit.
 *
 * Čisté mapování (`buildScoringInput`) žije v `recoverInput.ts`, aby šlo testovat
 * bez tažení Prisma klienta / webhook routeru.
 */
import { PrismaClient } from "@prisma/client";
import { scoreApplicant } from "./claude";
import { determineScoringStatus } from "./status";
import { buildScoringInput, DEFAULT_STUCK_MINUTES, DEFAULT_BATCH_LIMIT } from "./recoverInput";
import { triggerReferenceCallIfPossible } from "../routes/webhook";
import { sendTelegram } from "../lib/telegram";

const prisma = new PrismaClient();

export interface RecoverSummary {
  found: number;
  scored: number;
  failed: number;
}

export interface RecoverOptions {
  /** Stáří v minutách, po kterém je `new` uchazeč považován za uvízlého. */
  olderThanMinutes?: number;
  /** Max počet uchazečů na jeden běh. */
  limit?: number;
  /** Poslat Telegram alert, když se něco zachrání (default true). Ztracený trigger je signál problému. */
  alert?: boolean;
}

/**
 * Najde uvízlé `new` uchazeče starší než práh a přescóruje je.
 * Vrací souhrn pro logování a monitoring.
 */
export async function recoverStuckApplicants(
  opts: RecoverOptions = {}
): Promise<RecoverSummary> {
  const olderThanMinutes = opts.olderThanMinutes ?? DEFAULT_STUCK_MINUTES;
  const limit = opts.limit ?? DEFAULT_BATCH_LIMIT;
  const alert = opts.alert ?? true;

  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);

  const stuck = await prisma.applicant.findMany({
    where: { status: "new", createdAt: { lt: cutoff } },
    include: { listing: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  const summary: RecoverSummary = { found: stuck.length, scored: 0, failed: 0 };

  if (stuck.length === 0) return summary;

  console.warn(
    `[recover] Našel jsem ${stuck.length} uvízlých uchazečů ve stavu "new" starších než ${olderThanMinutes} min — přescórovávám`
  );

  for (const applicant of stuck) {
    try {
      const input = buildScoringInput(applicant, applicant.listing);
      const result = await scoreApplicant(input);
      const newStatus = determineScoringStatus(result.score);

      await prisma.applicant.update({
        where: { id: applicant.id },
        data: {
          score: result.score,
          scoringReason: result.oduvodneni,
          aiNote: result.ai_poznamka,
          vyjimecny: result.vyjimecny ?? false,
          status: newStatus,
        },
      });

      summary.scored++;
      console.log(
        `[recover] Applicant ${applicant.id} → score ${result.score} → ${newStatus} (zachráněno)`
      );

      // Pokračuj v pipeline stejně jako živý /webhook/score.
      if (newStatus === "awaiting_reference") {
        triggerReferenceCallIfPossible(applicant.id).catch((err) =>
          console.error(`[recover] Auto-trigger reference ${applicant.id} selhal:`, err)
        );
      }
    } catch (err) {
      summary.failed++;
      console.error(`[recover] Scoring uvízlého ${applicant.id} selhal:`, err);
      await prisma.applicant
        .update({ where: { id: applicant.id }, data: { status: "score-error" } })
        .catch(() => {});
    }
  }

  if (alert && summary.scored > 0) {
    await sendTelegram(
      `⚠️ <b>Scoring recovery</b>\nZachráněno ${summary.scored} uvízlých uchazečů (ve stavu "new" > ${olderThanMinutes} min).` +
        (summary.failed > 0 ? `\nSelhalo: ${summary.failed}.` : "") +
        `\nZnamená to, že živý scoring trigger někde tiše selhal — stojí za kontrolu (VPS dostupnost / deploy).`
    );
  }

  return summary;
}
