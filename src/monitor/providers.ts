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

/**
 * CEE (Exekutorská komora) — zbývající placené dotazy z prepaid kreditu.
 * Auth: POST /api/v4/auth?api_key=&api_secret= (POZOR: query params, ne body!) → data.token_value
 * Balance: GET /api/v4/credit?token= → data.zbyva_dotazu.placenych, data.credit (Kč)
 */
export async function getCeeCredit(lowThresholdQueries: number): Promise<ProviderStatus> {
  const label = "CEE (exekuce)";
  const apiKey = process.env.CEE_API_KEY;
  const apiSecret = process.env.CEE_API_SECRET;
  if (!apiKey || !apiSecret) return { label, value: "—", low: false, error: "chybí CEE_API_KEY / CEE_API_SECRET" };

  try {
    const base = "https://www.ceecr.cz/api/v4";
    const authRes = await fetch(
      `${base}/auth?api_key=${encodeURIComponent(apiKey)}&api_secret=${encodeURIComponent(apiSecret)}`,
      { method: "POST", signal: AbortSignal.timeout(12_000) }
    );
    const authData = (await authRes.json()) as { data?: { token_value?: string } };
    const token = authData.data?.token_value;
    if (!token) return { label, value: "—", low: false, error: `auth selhal (HTTP ${authRes.status})` };

    const creditRes = await fetch(`${base}/credit?token=${encodeURIComponent(token)}`, {
      signal: AbortSignal.timeout(12_000),
    });
    const creditData = (await creditRes.json()) as {
      data?: { credit?: number; zbyva_dotazu?: { placenych?: number } };
    };
    const queries = creditData.data?.zbyva_dotazu?.placenych;
    const kc = creditData.data?.credit;
    if (typeof queries !== "number") {
      return { label, value: "neznámé", low: false };
    }
    const kcLabel = typeof kc === "number" ? ` (${kc} Kč)` : "";
    return { label, value: `${queries} dotazů${kcLabel}`, low: queries < lowThresholdQueries };
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
