/**
 * Generuje PDF shortlistu uchazečů pro majitele bytu.
 * Používá pdfkit — čisté Node.js, bez Chromia.
 */

import PDFDocument from "pdfkit";

export interface ShortlistApplicant {
  name: string;
  score: number;
  aiNote: string | null;
  referenceResult: string | null;
  referenceNote: string | null;
  isirResult: string | null;
  ceeResult: string | null;
  income: number | null;
  employment: string | null;
  personsCount: number | null;
  hasPets: boolean;
  moveReason: string | null;
  email: string;
  phone: string;
}

export interface ShortlistPdfParams {
  listingAddress: string;
  ownerName: string;
  generatedAt: Date;
  applicants: ShortlistApplicant[];
}

const COLORS = {
  primary: "#1a56db",
  success: "#166534",
  danger: "#991b1b",
  warning: "#92400e",
  gray: "#6b7280",
  darkGray: "#374151",
  lightGray: "#f3f4f6",
  border: "#e5e7eb",
};

function registryLabel(result: string | null): { text: string; isOk: boolean } {
  if (!result || result === "not_checked") return { text: "Nezkontrolováno", isOk: false };
  if (result === "clean") return { text: "Bez záznamu", isOk: true };
  if (result === "execution_found") return { text: "Exekuce nalezeny", isOk: false };
  if (result === "insolvency_found") return { text: "Insolvence nalezena", isOk: false };
  if (result === "error") return { text: "Chyba kontroly", isOk: false };
  return { text: result, isOk: false };
}

function referenceLabel(result: string | null): { text: string; color: string } {
  if (!result) return { text: "Neproveden", color: COLORS.gray };
  if (result === "positive") return { text: "Pozitivní", color: COLORS.success };
  if (result === "neutral") return { text: "Neutrální", color: COLORS.warning };
  if (result === "negative") return { text: "Negativní", color: COLORS.danger };
  return { text: result, color: COLORS.gray };
}

function scoreColor(score: number): string {
  if (score >= 70) return COLORS.success;
  if (score >= 40) return COLORS.warning;
  return COLORS.danger;
}

export function generateShortlistPdf(params: ShortlistPdfParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];

    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // ---- Hlavička ----
    doc
      .fillColor(COLORS.primary)
      .fontSize(22)
      .font("Helvetica-Bold")
      .text("NajdiNájemníka.cz", 50, 50);

    doc
      .fillColor(COLORS.darkGray)
      .fontSize(14)
      .font("Helvetica-Bold")
      .text("Shortlist uchazečů o pronájem", 50, 80);

    doc
      .fillColor(COLORS.gray)
      .fontSize(10)
      .font("Helvetica")
      .text(`Byt: ${params.listingAddress}`, 50, 100)
      .text(`Majitel: ${params.ownerName}`, 50, 114)
      .text(
        `Vygenerováno: ${params.generatedAt.toLocaleDateString("cs-CZ", { day: "2-digit", month: "2-digit", year: "numeric" })}`,
        50,
        128
      );

    // Oddělovač
    doc
      .moveTo(50, 148)
      .lineTo(doc.page.width - 50, 148)
      .strokeColor(COLORS.border)
      .stroke();

    let y = 165;

    // ---- Kandidáti ----
    params.applicants.forEach((a, idx) => {
      // Zkontroluj místo — nová stránka pokud zbývá méně než 180pt
      if (y > doc.page.height - 200) {
        doc.addPage();
        y = 50;
      }

      const ref = referenceLabel(a.referenceResult);
      const isir = registryLabel(a.isirResult);
      const cee = registryLabel(a.ceeResult);

      // Pořadí + jméno
      doc
        .fillColor(COLORS.primary)
        .fontSize(13)
        .font("Helvetica-Bold")
        .text(`${idx + 1}. ${a.name}`, 50, y);

      // Score badge
      const scoreText = `${a.score} bodů`;
      doc
        .fillColor(scoreColor(a.score))
        .fontSize(12)
        .font("Helvetica-Bold")
        .text(scoreText, doc.page.width - 120, y, { width: 70, align: "right" });

      y += 20;

      // Základní info
      const infoLine = [
        a.income != null ? `Příjem: ${a.income.toLocaleString("cs-CZ")} Kč` : null,
        a.employment ?? null,
        a.personsCount != null ? `${a.personsCount} os.` : null,
        a.hasPets ? "Má mazlíčka" : null,
      ]
        .filter(Boolean)
        .join("  ·  ");

      if (infoLine) {
        doc
          .fillColor(COLORS.gray)
          .fontSize(9)
          .font("Helvetica")
          .text(infoLine, 50, y);
        y += 14;
      }

      // Kontakt
      doc
        .fillColor(COLORS.gray)
        .fontSize(9)
        .font("Helvetica")
        .text(`${a.email}  ·  ${a.phone}`, 50, y);
      y += 14;

      // AI poznámka
      if (a.aiNote) {
        doc
          .fillColor(COLORS.darkGray)
          .fontSize(10)
          .font("Helvetica")
          .text(`AI poznámka: ${a.aiNote}`, 50, y, { width: doc.page.width - 100 });
        y += doc.heightOfString(`AI poznámka: ${a.aiNote}`, { width: doc.page.width - 100 }) + 4;
      }

      // Důvod stěhování
      if (a.moveReason) {
        doc
          .fillColor(COLORS.gray)
          .fontSize(9)
          .font("Helvetica")
          .text(`Důvod stěhování: ${a.moveReason}`, 50, y, { width: doc.page.width - 100 });
        y += 13;
      }

      // Reference + registry řádek
      const refText = `Reference: ${ref.text}${a.referenceNote ? ` (${a.referenceNote})` : ""}`;
      doc
        .fillColor(ref.color)
        .fontSize(9)
        .font("Helvetica-Bold")
        .text(refText, 50, y, { width: doc.page.width - 100 });
      y += 13;

      const registryText =
        `ISIR: ${isir.text}  ·  CEE: ${cee.text}`;
      doc
        .fillColor(isir.isOk && cee.isOk ? COLORS.success : COLORS.danger)
        .fontSize(9)
        .font("Helvetica-Bold")
        .text(registryText, 50, y);
      y += 18;

      // Oddělovač mezi kandidáty
      if (idx < params.applicants.length - 1) {
        doc
          .moveTo(50, y)
          .lineTo(doc.page.width - 50, y)
          .strokeColor(COLORS.border)
          .stroke();
        y += 12;
      }
    });

    // ---- Patička ----
    const footerY = doc.page.height - 60;
    doc
      .moveTo(50, footerY - 10)
      .lineTo(doc.page.width - 50, footerY - 10)
      .strokeColor(COLORS.border)
      .stroke();

    doc
      .fillColor(COLORS.gray)
      .fontSize(8)
      .font("Helvetica")
      .text(
        "Tento dokument byl vygenerován automaticky platformou NajdiNájemníka.cz. " +
          "Výsledky vychází z veřejných registrů a AI hodnocení ke dni generování. " +
          "Nenahrazuje právní poradenství. Zpracování v souladu s GDPR.",
        50,
        footerY,
        { width: doc.page.width - 100, align: "center" }
      );

    doc.end();
  });
}
