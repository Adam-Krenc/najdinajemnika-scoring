/**
 * Zjištění zůstatků/útraty u jednotlivých poskytovatelů.
 *
 * Každá funkce je odolná vůči chybám — místo vyhození vrací stav s `error`,
 * aby výpadek jednoho API nezablokoval celý přehled.
 */

export interface ProviderStatus {
  /** Lidsky čitelný název služby */
  label: string;
  /** Naformátovaná hodnota k zobrazení (např. "$12.34" nebo "150 SMS") */
  value: string;
  /** true = pod prahem → varování */
  low: boolean;
  /** vyplněno při selhání dotazu */
  error?: string;
}

/** Brevo — zbývající SMS kredity. GET /v3/account → plan[type=sms].credits */
export async function getBrevoSmsCredits(lowThreshold: number): Promise<ProviderStatus> {
  const label = "Brevo SMS";
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) return { label, value: "—", low: false, error: "chybí BREVO_API_KEY" };

  try {
    const res = await fetch("https://api.brevo.com/v3/account", {
      headers: { "api-key": apiKey, accept: "application/json" },
    });
    if (!res.ok) {
      return { label, value: "—", low: false, error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as { plan?: Array<{ type?: string; credits?: number }> };
    const smsPlan = (data.plan ?? []).find((p) => p.type === "sms");
    if (!smsPlan || typeof smsPlan.credits !== "number") {
      return { label, value: "neznámé (žádný SMS plán)", low: false };
    }
    const credits = smsPlan.credits;
    return { label, value: `${credits} SMS`, low: credits < lowThreshold };
  } catch (err) {
    return { label, value: "—", low: false, error: String(err) };
  }
}

/** Twilio — $ zůstatek účtu. GET /2010-04-01/Accounts/{sid}/Balance.json */
export async function getTwilioBalance(lowThreshold: number): Promise<ProviderStatus> {
  const label = "Twilio";
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return { label, value: "—", low: false, error: "chybí TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN" };

  try {
    const auth = Buffer.from(`${sid}:${token}`).toString("base64");
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Balance.json`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (!res.ok) {
      return { label, value: "—", low: false, error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as { balance?: string; currency?: string };
    const balance = parseFloat(data.balance ?? "NaN");
    const currency = data.currency ?? "USD";
    if (Number.isNaN(balance)) {
      return { label, value: "neznámé", low: false };
    }
    return { label, value: `${balance.toFixed(2)} ${currency}`, low: balance < lowThreshold };
  } catch (err) {
    return { label, value: "—", low: false, error: String(err) };
  }
}
