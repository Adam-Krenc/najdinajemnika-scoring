/**
 * VAPI outbound call pro referenční hovor s předchozím pronajímatelem.
 * Env: VAPI_API_KEY, VAPI_REFERENCE_ASSISTANT_ID, VAPI_PHONE_NUMBER_ID
 */

const VAPI_BASE = "https://api.vapi.ai";

export interface VapiOutboundResult {
  ok: boolean;
  callId?: string;
  error?: string;
}

export async function createReferenceCall(params: {
  applicantName: string;
  landlordPhone: string;
  listingAddress: string;
}): Promise<VapiOutboundResult> {
  const apiKey = process.env.VAPI_API_KEY;
  const assistantId = process.env.VAPI_REFERENCE_ASSISTANT_ID;
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;

  if (!apiKey || !assistantId || !phoneNumberId) {
    return {
      ok: false,
      error:
        "VAPI není nakonfigurováno — chybí VAPI_API_KEY / VAPI_REFERENCE_ASSISTANT_ID / VAPI_PHONE_NUMBER_ID",
    };
  }

  try {
    const res = await fetch(`${VAPI_BASE}/call/phone`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        assistantId,
        phoneNumberId,
        customer: { number: params.landlordPhone },
        assistantOverrides: {
          variableValues: {
            applicantName: params.applicantName,
            listingAddress: params.listingAddress,
          },
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `VAPI API selhal: HTTP ${res.status} — ${body}` };
    }

    const data = (await res.json()) as { id?: string };
    return { ok: true, callId: data.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `VAPI fetch selhal: ${msg}` };
  }
}

/** Volací okno: hodina spadá do 9:00–16:59 (tj. 9 ≤ hour < 17). Čistá fce — testovatelná. */
export function isWithinCallHours(hour: number): boolean {
  return hour >= 9 && hour < 17;
}

/** Vrátí true pokud je aktuálně 9:00–17:00 pražského času */
export function isCallHour(): boolean {
  const formatter = new Intl.DateTimeFormat("cs-CZ", {
    timeZone: "Europe/Prague",
    hour: "numeric",
    hour12: false,
  });
  const hour = parseInt(formatter.format(new Date()), 10);
  return isWithinCallHours(hour);
}
