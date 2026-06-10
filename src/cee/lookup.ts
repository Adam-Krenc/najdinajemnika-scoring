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

/**
 * Získá krátkodobý token (IP-vázaný, platný ~5 min).
 * POZOR: CEE API čeká api_key/api_secret jako QUERY PARAMETRY, ne v těle requestu
 * (s tělem vrací 5501 "Chybí API KEY!"). Token je v odpovědi pod `data.token_value`.
 */
async function getToken(): Promise<string> {
  const apiKey = process.env.CEE_API_KEY;
  const apiSecret = process.env.CEE_API_SECRET;

  if (!apiKey || !apiSecret) {
    throw new Error("CEE_API_KEY nebo CEE_API_SECRET není nastaven v .env");
  }

  const url = `${CEE_BASE}/auth?api_key=${encodeURIComponent(apiKey)}&api_secret=${encodeURIComponent(apiSecret)}`;
  const res = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`CEE auth selhal: HTTP ${res.status} — ${body}`);
  }

  const json = await res.json() as { data?: { token_value?: string }; status?: number };
  const token = json.data?.token_value;
  if (!token) {
    throw new Error(`CEE auth: token nebyl vrácen — ${JSON.stringify(json)}`);
  }

  return token;
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

    // Vyhledání subjektu podle jména.
    // Token předáváme jako query param `?token=` (ověřený vzor z /credit) i jako
    // Bearer hlavičku pro jistotu. POZOR: tělo requestu (type/firstName/lastName)
    // se nepodařilo ověřit — CEE účet má 0 kreditu, takže reálný /subject/search
    // nešlo otestovat. Po dobití kreditu ověřit, že formát těla sedí (viz ceecr.cz/dev).
    const searchRes = await fetch(`${CEE_BASE}/subject/search?token=${encodeURIComponent(token)}`, {
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
