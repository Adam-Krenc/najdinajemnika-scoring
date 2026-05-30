// ISIR vyhledávání přes web scraping (findDluznik.do)
// ISIR nemá veřejné REST API — vyžaduje session cookie z index.do.
// Z německých/zahraničních VPS IP může vracet 500 → rawResult: "error"
// → webhook pak fallback na admin notifikaci místo auto-complete.

export interface IsirLookupResult {
  rawResult: "clean" | "insolvency_found" | "error";
  count: number;
  note?: string;
}

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "cs,en;q=0.5",
};

function splitName(fullName: string): { jmeno: string; nazev: string } {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return { jmeno: "", nazev: parts[0] };
  return { jmeno: parts.slice(0, -1).join(" "), nazev: parts[parts.length - 1] };
}

// Extrahuje počet výsledků z HTML odpovědi ISIR
function parseIsirResults(html: string): number {
  // ISIR zobrazuje "Počet nalezených záznamů: X" nebo tabulku výsledků
  const countMatch = html.match(/Počet nalezených[^:]*:\s*(\d+)/i);
  if (countMatch) return parseInt(countMatch[1], 10);

  // Záložní: spočítej řádky tabulky výsledků (tr s odkazy na věci)
  const rows = html.match(/\/isir\/usl\/vec-detail\.do\?/g);
  return rows ? rows.length : 0;
}

function isErrorPage(html: string): boolean {
  return html.includes("Chyba serveru") || html.includes("Error 500") || html.includes("Nedostupný systém");
}

export async function lookupIsir(tenantName: string): Promise<IsirLookupResult> {
  const { jmeno, nazev } = splitName(tenantName);

  try {
    // Krok 1: získej session cookie z hlavní stránky
    const indexRes = await fetch("https://isir.justice.cz/isir/common/index.do", {
      headers: HEADERS,
      signal: AbortSignal.timeout(10_000),
      redirect: "follow",
    });

    if (!indexRes.ok) {
      return { rawResult: "error", count: 0, note: `ISIR index.do vrátil ${indexRes.status}` };
    }

    const indexHtml = await indexRes.text();

    // Extrahuj jsessionid z HTML nebo cookie headeru
    const jsessionMatch = indexHtml.match(/jsessionid=([A-Za-z0-9._:-]+)/);
    const jsessionId = jsessionMatch?.[1] ?? "";

    const setCookie = indexRes.headers.get("set-cookie") ?? "";
    const cookieMatch = setCookie.match(/JSESSIONID="?([^";]+)"?/i);
    const cookieId = cookieMatch?.[1] ?? jsessionId;

    if (!cookieId) {
      return { rawResult: "error", count: 0, note: "Nepodařilo se získat session ISIR" };
    }

    // Krok 2: prohledej dlužníky se session
    const params = new URLSearchParams({ typ: "OSOBA", nazev, rc: "", datumNarozeni: "" });
    if (jmeno) params.set("jmeno", jmeno);

    const searchUrl = `https://isir.justice.cz/isir/common/findDluznik.do;jsessionid=${cookieId}?${params.toString()}`;

    const searchRes = await fetch(searchUrl, {
      headers: {
        ...HEADERS,
        "Cookie": `JSESSIONID="${cookieId}"`,
        "Referer": "https://isir.justice.cz/isir/common/index.do",
      },
      signal: AbortSignal.timeout(12_000),
    });

    const html = await searchRes.text();

    if (!searchRes.ok || isErrorPage(html)) {
      console.warn(`[isir] findDluznik.do vrátil ${searchRes.status} nebo chybovou stránku`);
      return {
        rawResult: "error",
        count: 0,
        note: "ISIR není dostupný automaticky (HTTP 500) – zkontrolujte ručně na isir.justice.cz",
      };
    }

    const count = parseIsirResults(html);

    if (count === 0) {
      return { rawResult: "clean", count: 0 };
    }

    return {
      rawResult: "insolvency_found",
      count,
      note: `Nalezeno ${count} záznam(ů) v ISIR pro "${tenantName}". Ověřte datem narození na isir.justice.cz.`,
    };
  } catch (err) {
    console.error("[isir] Chyba:", err);
    return {
      rawResult: "error",
      count: 0,
      note: "ISIR není dostupný automaticky – zkontrolujte ručně na isir.justice.cz",
    };
  }
}
