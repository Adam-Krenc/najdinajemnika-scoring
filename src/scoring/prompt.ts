export const SCORING_SYSTEM_PROMPT = `Jsi expert na prověřování nájemníků v České republice. Vrátíš POUZE validní JSON bez markdown, bez komentářů, bez kódu.

SCORING KRITÉRIA (celkem 100 bodů):
- Poměr příjem/nájem (ideál ≥ 3×): 30 bodů
- Zaměstnanost a stabilita příjmu: 25 bodů
- Počet osob vs. kapacita bytu: 15 bodů
- Shoda s preferencemi majitele (mazlíčci atd.): 15 bodů
- Motivace, zpráva, reference: 15 bodů

Vrať POUZE tento JSON (žádný jiný text):
{
  "score": <číslo 0–100>,
  "doporuceni": "<doporučujeme|zvažte|nedoporučujeme>",
  "oduvodneni": "<1–2 věty česky, max 200 znaků>",
  "rizika": ["<riziko 1>"],
  "silne_stranky": ["<silná stránka 1>"]
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
    income?: number | null;
    employment?: string | null;
    personsCount?: number | null;
    hasPets: boolean;
    message?: string | null;
    previousAddress?: string | null;
  };
}

export interface ScoringResult {
  score: number;
  doporuceni: "doporučujeme" | "zvažte" | "nedoporučujeme";
  oduvodneni: string;
  rizika: string[];
  silne_stranky: string[];
}

export function buildScoringPrompt(input: ScoringInput): string {
  const { listing, applicant } = input;
  return `BYT: ${listing.city}, ${listing.size}, nájem ${listing.rent} Kč/měs, max ${listing.maxPersons} osob, mazlíčci: ${listing.petsAllowed}, preference nájemníka: ${listing.tenantPref}

ŽADATEL:
  Příjem: ${applicant.income != null ? `${applicant.income} Kč/měs` : "neuvedeno"}
  Zaměstnání: ${applicant.employment ?? "neuvedeno"}
  Počet osob v domácnosti: ${applicant.personsCount ?? "neuvedeno"}
  Mazlíček: ${applicant.hasPets ? "ano" : "ne"}
  Reference (předchozí pronajímatel): ${applicant.previousAddress ?? "neuvedena"}
  Zpráva majiteli: ${applicant.message ?? "—"}`;
}
