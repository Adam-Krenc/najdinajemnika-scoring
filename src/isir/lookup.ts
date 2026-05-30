// ISIR REST API – veřejný rejstřík, bez API klíče
// Docs: https://isir.justice.cz
// Poznámka: hledáme pouze podle jména (bez data narození) → možné false positives

export interface IsirRecord {
  idOsoby: string;
  nazev: string;
  jmeno?: string;
  datumNarozeni?: string;
  druhOsoby: string;
  stavRizeni?: string;
  vec?: string;
}

export interface IsirLookupResult {
  rawResult: "clean" | "insolvency_found" | "error";
  count: number;
  records: IsirRecord[];
  note?: string;
}

const ISIR_BASE = "https://isir.justice.cz/isir/common/rest";

// Rozdělí "Jan Novák" → { jmeno: "Jan", nazev: "Novák" }
function splitName(fullName: string): { jmeno: string; nazev: string } {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return { jmeno: "", nazev: parts[0] };
  const nazev = parts[parts.length - 1];
  const jmeno = parts.slice(0, -1).join(" ");
  return { jmeno, nazev };
}

export async function lookupIsir(tenantName: string): Promise<IsirLookupResult> {
  const { jmeno, nazev } = splitName(tenantName);

  const params = new URLSearchParams({ nazev, typ: "OSOBA" });
  if (jmeno) params.set("jmeno", jmeno);

  const url = `${ISIR_BASE}/findDluznik?${params.toString()}`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error("[isir] Fetch chyba:", err);
    return { rawResult: "error", count: 0, records: [], note: "Síťová chyba při volání ISIR" };
  }

  if (!response.ok) {
    console.error("[isir] HTTP chyba:", response.status);
    return { rawResult: "error", count: 0, records: [], note: `ISIR vrátil HTTP ${response.status}` };
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return { rawResult: "error", count: 0, records: [], note: "ISIR vrátil neplatný JSON" };
  }

  // ISIR vrací pole dlužníků nebo objekt s polem
  const records: IsirRecord[] = Array.isArray(data)
    ? (data as IsirRecord[])
    : ((data as Record<string, unknown>)?.dluznici as IsirRecord[]) ?? [];

  if (records.length === 0) {
    return { rawResult: "clean", count: 0, records: [] };
  }

  return {
    rawResult: "insolvency_found",
    count: records.length,
    records,
    note: `Nalezeno ${records.length} záznam(ů) v ISIR pro "${tenantName}". Výsledek je pouze podle jména – doporučujeme ověřit datem narození.`,
  };
}
