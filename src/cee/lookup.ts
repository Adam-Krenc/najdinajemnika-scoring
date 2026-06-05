/**
 * CEE lookup přes oficální API Exekutorské komory ČR (ceecr.cz API v4.2)
 *
 * Registrace: helpdesk@ceecr.cz
 * Env proměnné: CEE_API_KEY, CEE_API_SECRET
 * Cena: ~60 Kč/dotaz (deduktováno z prepaid kreditu)
 * Dokumentace: https://www.ceecr.cz/dev
 *
 * Důležité: vyhledáváme jen podle jména — bez data narození může dojít
 * k falešným pozitivům. Výsledky jsou vždy doplněny poznámkou pro admina.
 */

const CEE_BASE = "https://www.ceecr.cz/api/v4";

export interface CeeLookupResult {
  rawResult: "clean" | "execution_found" | "error";
  count: number;
  note?: string;
}

/** Získá krátkodobý Bearer token (platný ~60 min) */
async function getToken(): Promise<string> {
  const apiKey = process.env.CEE_API_KEY;
  const apiSecret = process.env.CEE_API_SECRET;

  if (!apiKey || !apiSecret) {
    throw new Error("CEE_API_KEY nebo CEE_API_SECRET není nastaven v .env");
  }

  const res = await fetch(`${CEE_BASE}/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey, api_secret: apiSecret }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`CEE auth selhal: HTTP ${res.status} — ${body}`);
  }

  const data = await res.json() as { token?: string; error?: string };
  if (!data.token) {
    throw new Error(`CEE auth: token nebyl vrácen — ${JSON.stringify(data)}`);
  }

  return data.token;
}

export function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: "", lastName: parts[0] };
  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts[parts.length - 1],
  };
}

/** Vyhledá subjekt v CEE podle jména a vrátí počet exekucí */
export async function lookupCee(tenantName: string): Promise<CeeLookupResult> {
  if (!process.env.CEE_API_KEY || !process.env.CEE_API_SECRET) {
    return {
      rawResult: "error",
      count: 0,
      note: "CEE API není nakonfigurováno (chybí CEE_API_KEY / CEE_API_SECRET). Zkontrolujte ručně na ceecr.cz.",
    };
  }

  const { firstName, lastName } = splitName(tenantName);

  try {
    const token = await getToken();

    // Vyhledání subjektu podle jména
    const searchRes = await fetch(`${CEE_BASE}/subject/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({
        type: "FO",          // FO = fyzická osoba
        firstName,
        lastName,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!searchRes.ok) {
      const body = await searchRes.text().catch(() => "");
      console.warn(`[cee] search HTTP ${searchRes.status}: ${body}`);
      return {
        rawResult: "error",
        count: 0,
        note: `CEE search selhal: HTTP ${searchRes.status}. Zkontrolujte ručně na ceecr.cz.`,
      };
    }

    const searchData = await searchRes.json() as {
      subjects?: Array<{ id: string; executionCount?: number; name?: string }>;
      total?: number;
    };

    const subjects = searchData.subjects ?? [];

    if (subjects.length === 0) {
      return { rawResult: "clean", count: 0 };
    }

    // Součet exekucí přes všechny nalezené subjekty se shodným jménem
    const totalExecutions = subjects.reduce(
      (sum, s) => sum + (s.executionCount ?? 0),
      0
    );

    if (totalExecutions === 0) {
      return {
        rawResult: "clean",
        count: 0,
        note:
          subjects.length > 1
            ? `Nalezeno ${subjects.length} osob se jménem "${tenantName}", žádná nemá exekuci. Doporučujeme ověřit datem narození na ceecr.cz.`
            : undefined,
      };
    }

    return {
      rawResult: "execution_found",
      count: totalExecutions,
      note: `Nalezeno ${totalExecutions} exekucí u ${subjects.length} osoby/osob se jménem "${tenantName}". Shodu ověřte datem narození na ceecr.cz.`,
    };
  } catch (err) {
    console.error("[cee] Chyba:", err);
    const msg = err instanceof Error ? err.message : String(err);
    return {
      rawResult: "error",
      count: 0,
      note: `CEE není dostupné automaticky (${msg}). Zkontrolujte ručně na ceecr.cz.`,
    };
  }
}
