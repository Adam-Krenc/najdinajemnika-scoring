import { Resend } from "resend";
import { escapeHtml } from "../lib/html";

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL ?? "https://www.najdinajemnika.cz";

const resend = new Resend(process.env.RESEND_API_KEY);

const RESULT_LABELS: Record<string, string> = {
  clean: "Bez záznamu",
  insolvency_found: "Nalezena insolvence",
  error: "Nepodařilo se ověřit",
};

export async function sendIsirResults(params: {
  landlordName: string;
  landlordEmail: string;
  tenantName: string;
  isirResult: "clean" | "insolvency_found" | "error";
  note?: string | null;
  packageLabel: string;
}) {
  const { landlordEmail, isirResult, packageLabel } = params;
  // Tělo je HTML → escapujeme uživatelská data; subject je plain-text → raw.
  const landlordName = escapeHtml(params.landlordName);
  const tenantName = escapeHtml(params.tenantName);
  const note = params.note ? escapeHtml(params.note) : params.note;
  const label = RESULT_LABELS[isirResult] ?? isirResult;

  const badge =
    isirResult === "clean"
      ? `<span style="background:#dcfce7;color:#166534;padding:2px 8px;border-radius:4px;font-size:13px;">&#10003; ${label}</span>`
      : isirResult === "error"
      ? `<span style="background:#fef9c3;color:#92400e;padding:2px 8px;border-radius:4px;font-size:13px;">&#9888; ${label}</span>`
      : `<span style="background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:4px;font-size:13px;">&#9888; ${label}</span>`;

  await resend.emails.send({
    from: "NajdiNájemníka.cz <obchod@smartapky.cz>",
    to: landlordEmail,
    subject: `Výsledky prověření nájemníka ${params.tenantName} – NajdiNájemníka.cz`,
    html: `
      <div style="font-family: Inter, sans-serif; max-width: 600px; margin: 0 auto; padding: 32px;">
        <h1 style="color: #1a56db; font-size: 24px; margin-bottom: 8px;">Výsledky prověření</h1>
        <p style="color: #374151; font-size: 16px;">Dobrý den, ${landlordName},</p>
        <p style="color: #374151; font-size: 16px;">
          Prověření nájemníka <strong>${tenantName}</strong> (${packageLabel}) bylo dokončeno automaticky.
        </p>
        <div style="background: #f9fafb; border-radius: 8px; padding: 20px; margin: 24px 0;">
          <h2 style="color: #374151; font-size: 16px; margin: 0 0 12px;">Výsledky kontrol</h2>
          <p style="margin: 8px 0; color: #374151;">
            <strong>Insolvenční rejstřík (ISIR):</strong>&nbsp;${badge}
          </p>
          ${note ? `<p style="margin-top: 12px; color: #6b7280; font-size: 13px;">${note}</p>` : ""}
        </div>
        <p style="color: #6b7280; font-size: 13px;">
          Tato zpráva slouží jako informace na základě veřejně dostupných registrů ke dni prověření.
          Nenahrazuje právní poradenství. Všechna data jsou zpracována v souladu s GDPR.
        </p>
        <p style="color: #6b7280; font-size: 14px; margin-top: 32px;">© 2025 NajdiNájemníka.cz</p>
      </div>
    `,
  });
}

export async function sendAdminIsirFallback(params: {
  verificationId: string;
  landlordName: string;
  landlordEmail: string;
  tenantName: string;
  tenantEmail: string;
  packageLabel: string;
  isirNote?: string;
}) {
  const { verificationId, landlordEmail, packageLabel } = params;
  // Tělo je HTML → escapujeme uživatelská data; subject je plain-text → raw.
  const landlordName = escapeHtml(params.landlordName);
  const tenantName = escapeHtml(params.tenantName);
  const tenantEmail = escapeHtml(params.tenantEmail);
  const isirNote = params.isirNote ? escapeHtml(params.isirNote) : params.isirNote;
  const adminUrl = `${BASE_URL}/admin/verifications/${verificationId}`;

  await resend.emails.send({
    from: "NajdiNájemníka.cz <obchod@smartapky.cz>",
    to: "obchod@smartapky.cz",
    subject: `[Ověření – ISIR ruční] ${params.tenantName}`,
    html: `
      <div style="font-family: Inter, sans-serif; max-width: 600px; margin: 0 auto; padding: 32px;">
        <h1 style="color: #1a56db; font-size: 20px;">Ověření ke zpracování (ISIR nedostupný automaticky)</h1>
        <p style="color: #374151;">Nájemník udělil souhlas, ale automatická ISIR kontrola selhala. Proveďte kontrolu ručně.</p>
        ${isirNote ? `<p style="color: #92400e; background: #fefce8; padding: 10px; border-radius: 6px;">${isirNote}</p>` : ""}
        <div style="background: #f9fafb; border-radius: 8px; padding: 16px; margin: 16px 0;">
          <p style="margin: 4px 0;"><strong>ID:</strong> ${verificationId}</p>
          <p style="margin: 4px 0;"><strong>Balíček:</strong> ${packageLabel}</p>
          <p style="margin: 4px 0;"><strong>Pronajímatel:</strong> ${landlordName} (${landlordEmail})</p>
          <p style="margin: 4px 0;"><strong>Nájemník:</strong> ${tenantName} (${tenantEmail})</p>
        </div>
        <div style="background: #fefce8; border-radius: 8px; padding: 12px 16px; margin: 16px 0;">
          <p style="margin: 0; color: #92400e; font-weight: 600;">Co zkontrolovat:</p>
          <p style="margin: 4px 0; color: #78350f;">• ISIR: <a href="https://isir.justice.cz/isir/common/index.do" style="color: #1a56db;">isir.justice.cz</a></p>
          <p style="margin: 4px 0; color: #78350f;">• CEE: <a href="https://www.ceecr.cz/" style="color: #1a56db;">ceecr.cz</a></p>
        </div>
        <div style="text-align: center; margin: 24px 0;">
          <a href="${adminUrl}" style="background: #1a56db; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-size: 15px; font-weight: 600; display: inline-block;">
            Zadat výsledky v adminu
          </a>
        </div>
      </div>
    `,
  });
}
