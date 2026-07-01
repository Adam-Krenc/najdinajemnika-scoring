/**
 * ElevenLabs Conversational AI outbound call pro referenční hovor s předchozím
 * pronajímatelem. Nahrazuje VAPI (lepší český hlas + turn-taking, nativní TTS).
 *
 * Env: ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, ELEVENLABS_PHONE_NUMBER_ID
 *
 * Telefonie: ElevenLabs volá přes naimportované Twilio číslo (phone_number_id).
 * Po skončení hovoru ElevenLabs pošle post-call webhook → /webhook/elevenlabs/post-call.
 */

const ELEVENLABS_BASE = "https://api.elevenlabs.io";

export interface ReferenceCallResult {
  ok: boolean;
  /** ElevenLabs conversation_id — ukládá se do Applicant.referenceCallId */
  callId?: string;
  error?: string;
}

export async function createReferenceCall(params: {
  applicantName: string;
  landlordPhone: string;
  listingAddress: string;
}): Promise<ReferenceCallResult> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const agentId = process.env.ELEVENLABS_AGENT_ID;
  const phoneNumberId = process.env.ELEVENLABS_PHONE_NUMBER_ID;

  if (!apiKey || !agentId || !phoneNumberId) {
    return {
      ok: false,
      error:
        "ElevenLabs není nakonfigurováno — chybí ELEVENLABS_API_KEY / ELEVENLABS_AGENT_ID / ELEVENLABS_PHONE_NUMBER_ID",
    };
  }

  try {
    const res = await fetch(`${ELEVENLABS_BASE}/v1/convai/twilio/outbound-call`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": apiKey,
      },
      body: JSON.stringify({
        agent_id: agentId,
        agent_phone_number_id: phoneNumberId,
        to_number: params.landlordPhone,
        conversation_initiation_client_data: {
          dynamic_variables: {
            applicantName: params.applicantName,
            listingAddress: params.listingAddress,
          },
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `ElevenLabs API selhal: HTTP ${res.status} — ${body}` };
    }

    const data = (await res.json()) as {
      success?: boolean;
      conversation_id?: string;
      message?: string;
    };

    if (!data.success || !data.conversation_id) {
      return { ok: false, error: `ElevenLabs odmítl hovor: ${data.message ?? "neznámá chyba"}` };
    }

    return { ok: true, callId: data.conversation_id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `ElevenLabs fetch selhal: ${msg}` };
  }
}

/**
 * Z ElevenLabs post-call payloadu poskládá souvislý přepis hovoru
 * (role: agent/user → text) a detekuje, zda hovor nebyl zvednut.
 */
export function parsePostCallTranscript(payload: {
  transcript?: Array<{ role?: string; message?: string | null }>;
  metadata?: { call_duration_secs?: number };
  status?: string;
}): { transcript: string; noAnswer: boolean } {
  const turns = payload.transcript ?? [];
  const lines = turns
    .filter((t) => (t.message ?? "").trim().length > 0)
    .map((t) => `${t.role === "agent" ? "Asistent" : "Pronajímatel"}: ${(t.message ?? "").trim()}`);

  const transcript = lines.join("\n");

  // Žádná odpověď uživatele = nikdo to fakticky nezvedl / nemluvil
  const userSpoke = turns.some(
    (t) => t.role === "user" && (t.message ?? "").trim().length > 0
  );
  const duration = payload.metadata?.call_duration_secs ?? 0;
  const noAnswer = !userSpoke || duration < 3;

  return { transcript, noAnswer };
}
