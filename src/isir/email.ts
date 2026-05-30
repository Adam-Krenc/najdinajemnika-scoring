import { Resend } from "resend";

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
  const { landlordName, landlordEmail, tenantName, isirResult, note, packageLabel } = params;
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
    subject: `Výsledky prověření nájemníka ${tenantName} – NajdiNájemníka.cz`,
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
