export const SCORING_SYSTEM_PROMPT = `Jsi expert na prověřování nájemníků v České republice. Vrátíš POUZE validní JSON bez markdown, bez komentářů, bez kódu.

SCORING KRITÉRIA (celkem 100 bodů):

1. POMĚR PŘÍJEM/NÁJEM (25 bodů)
   - ≥ 3× nájem = 25 bodů
   - 2–3× nájem = 15 bodů
   - < 2× nájem = 5 bodů
   - Neuvedeno = 0 bodů
   - Doložený příjem (incomeProofUrl) = +5 bonus bodů (max 25)

2. STABILITA PŘÍJMU (20 bodů)
   - Zaměstnanec (HPP), státní zaměstnanec, důchodce, rodičovská/mateřská, podpora v nezaměstnanosti = 20 bodů (jistý pravidelný příjem)
   - OSVČ s prokazatelným příjmem = 15 bodů
   - Student s brigádou / nespecifikováno = 8 bodů
   - Neuvedeno = 0 bodů

3. ZÁZNAMY V REGISTRECH — vlastní přiznání (20 bodů)
   - Žádné exekuce, žádná insolvence = 20 bodů
   - Přiznal exekuce/insolvenci ALE vysvětlil a doložil řešení = 8 bodů
   - Přiznal exekuce/insolvenci bez vysvětlení = 2 body
   - POZOR: přiznání zmírňuje, NEOSPRAVEDLŇUJE — záznamy jsou vždy negativní signál

4. DŮVOD STĚHOVÁNÍ (15 bodů)
   - Pozitivní důvod (koupil/a vlastní byt, pracovní přesun, rozvoj rodiny, konec nájmu) = 15 bodů
   - Neutrální (blíže k práci, menší/větší byt) = 10 bodů
   - Podezřelý (konflikt s majitelem, vyhazov, zadlužení) = 2 body
   - Neuvedeno = 5 bodů

5. SHODA S BYTEM (10 bodů)
   - Počet osob ≤ kapacita bytu = 5 bodů, jinak 0
   - Mazlíčci odpovídají povolení = 5 bodů, jinak 0

6. KVALITA A ÚPLNOST PŘIHLÁŠKY (10 bodů)
   - Vyplnil téměř vše včetně volitelných polí = 10 bodů
   - Vyplnil povinné = 5 bodů
   - Minimální odpovědi = 2 body

Vrať POUZE tento JSON (žádný jiný text):
{
  "score": <číslo 0–100>,
  "doporuceni": "<doporučujeme|zvažte|nedoporučujeme>",
  "oduvodneni": "<2–3 věty česky, max 300 znaků — shrnutí pro admina>",
  "ai_poznamka": "<2–3 věty česky pro majitele — osobní, konkrétní, bez hodnocení číselným skóre>",
  "rizika": ["<konkrétní riziko>"],
  "silne_stranky": ["<konkrétní silná stránka>"],
  "vyjimecny": <true pokud score >= 95 a vše sedí, jinak false>
}`;

export interface ScoringInput {
  listing: {
    city: string;
    size: string;
    rent: number;
    maxPersons: number;
    petsAllowed: string;
    tenantPref: string;
  };
  applicant: {
    name?: string | null;
    dateOfBirth?: string | null;
    income?: number | null;
    employment?: string | null;
    incomeProofUrl?: string | null;
    personsCount?: number | null;
    householdMembers?: Array<{ name: string; dateOfBirth: string }> | null;
    hasPets: boolean;
    pets?: Array<{ type: string; breed?: string }> | null;
    moveReason?: string | null;
    hasExecutions?: boolean;
    executionDebt?: string | null;
    executionComment?: string | null;
    hasInsolvency?: boolean;
    insolvencyDebt?: string | null;
    insolvencyComment?: string | null;
    message?: string | null;
    additionalComment?: string | null;
  };
}

export interface ScoringResult {
  score: number;
  doporuceni: "doporučujeme" | "zvažte" | "nedoporučujeme";
  oduvodneni: string;
  ai_poznamka: string;
  rizika: string[];
  silne_stranky: string[];
  vyjimecny: boolean;
}

export function buildScoringPrompt(input: ScoringInput): string {
  const { listing, applicant } = input;

  const pets = applicant.pets?.length
    ? applicant.pets.map(p => `${p.type}${p.breed ? ` (${p.breed})` : ""}`).join(", ")
    : applicant.hasPets ? "ano (bez detailů)" : "ne";

  const household = applicant.householdMembers?.length
    ? applicant.householdMembers.map(m => `${m.name} (nar. ${m.dateOfBirth})`).join(", ")
    : "neuvedeno";

  const registryLines = [
    `Exekuce (vlastní přiznání): ${applicant.hasExecutions ? `ANO — ${applicant.executionDebt ?? ""} ${applicant.executionComment ?? ""}`.trim() : "ne"}`,
    `Insolvence (vlastní přiznání): ${applicant.hasInsolvency ? `ANO — ${applicant.insolvencyDebt ?? ""} ${applicant.insolvencyComment ?? ""}`.trim() : "ne"}`,
  ].join("\n  ");

  return `BYT: ${listing.city}, ${listing.size}, nájem ${listing.rent} Kč/měs, max ${listing.maxPersons} osob, mazlíčci: ${listing.petsAllowed}, preference nájemníka: ${listing.tenantPref}

ŽADATEL:
  Příjem: ${applicant.income != null ? `${applicant.income} Kč/měs` : "neuvedeno"}${applicant.incomeProofUrl ? " (doloženo)" : " (nedoloženo)"}
  Zaměstnání: ${applicant.employment ?? "neuvedeno"}
  Věk: ${applicant.dateOfBirth ?? "neuvedeno"}
  Počet osob v domácnosti: ${applicant.personsCount ?? "neuvedeno"}
  Členové domácnosti: ${household}
  Mazlíčci: ${pets}
  Důvod stěhování: ${applicant.moveReason ?? "neuvedeno"}
  ${registryLines}
  Zpráva majiteli: ${applicant.message ?? "—"}
  Dodatečný komentář: ${applicant.additionalComment ?? "—"}`;
}
