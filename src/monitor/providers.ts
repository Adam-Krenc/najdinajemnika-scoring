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

/**
 * ElevenLabs Conversational AI — využité MINUTY hovorů v aktuálním cyklu.
 *
 * Pozor: voicebot (Agents) se NEúčtuje z TTS znakové kvóty — jede na minuty +
 * LLM token passthrough, postpaid na kartu. Nemá tedy "zůstatek, který dojde";
 * sledujeme jen spotřebu/náklad. Minuty počítáme součtem call_duration_secs
 * přes konverzace od začátku aktuálního cyklu (GET /v1/convai/conversations).
 *
 * @param softHighMinutes volitelný měkký práh — když je překročen, řádek se
 *   označí 🔴 jako upozornění na neobvykle vysokou spotřebu (0 = bez prahu).
 */
export async function getElevenLabsMinutes(softHighMinutes: number): Promise<ProviderStatus> {
  const label = "ElevenLabs voicebot";
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return { label, value: "—", low: false, error: "chybí ELEVENLABS_API_KEY" };

  const headers = { "xi-api-key": apiKey };
  try {
    // Začátek aktuálního cyklu odvodíme z data obnovy kvóty (≈ reset − 30 dní);
    // při selhání spadneme na posledních 30 dní.
    let cycleStart = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;
    try {
      const subRes = await fetch("https://api.elevenlabs.io/v1/user/subscription", { headers });
      if (subRes.ok) {
        const sub = (await subRes.json()) as { next_character_count_reset_unix?: number };
        if (sub.next_character_count_reset_unix) cycleStart = sub.next_character_count_reset_unix - 30 * 24 * 3600;
      }
    } catch {
      /* fallback na rolling 30 dní */
    }

    // Projdi konverzace a sečti délky hovorů spadajících do cyklu.
    let totalSecs = 0;
    let cursor: string | undefined;
    for (let page = 0; page < 30; page++) {
      const url = `https://api.elevenlabs.io/v1/convai/conversations?page_size=100${cursor ? `&cursor=${cursor}` : ""}`;
      const res = await fetch(url, { headers });
      if (!res.ok) return { label, value: "—", low: false, error: `HTTP ${res.status}` };
      const data = (await res.json()) as {
        conversations?: Array<{ start_time_unix_secs?: number; call_duration_secs?: number }>;
        has_more?: boolean;
        next_cursor?: string;
      };
      for (const c of data.conversations ?? []) {
        if ((c.start_time_unix_secs ?? 0) >= cycleStart) totalSecs += c.call_duration_secs ?? 0;
      }
      if (!data.has_more || !data.next_cursor) break;
      cursor = data.next_cursor;
    }

    const minutes = Math.round(totalSecs / 60);
    const high = softHighMinutes > 0 && minutes >= softHighMinutes;
    return { label, value: `${minutes} min tento cyklus`, low: high };
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
