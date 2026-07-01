/**
 * Finální AI soudce na konci prověřovací kaskády (hlavní služba 5000+).
 * Dostane VŠECHNA data o uchazeči (skóre z dotazníku, výsledek reference, registry,
 * příjem, mazlíčci, sebepřiznané exekuce/insolvence…) a autonomně rozhodne:
 *
 *   - ultra_wow : mimořádně silný profil bez jediné výhrady → poslat majiteli OKAMŽITĚ
 *   - wow       : solidní finalista bez závažných problémů → držet do dávky (3-5 / 14 dní)
 *   - reject    : závažný problém → nepouštět dál
 *
 * Sonnet 5 (claude-sonnet-5) — stejný model jako prvotní scoring.
 */

import Anthropic from "@anthropic-ai/sdk";

export type FinalVerdict = "ultra_wow" | "wow" | "reject";

export interface FinalJudgeInput {
  // Dotazník + prvotní scoring
  name: string;
  score: number | null;
  scoringReason: string | null;
  aiNote: string | null;
  income: number | null;
  employment: string | null;
  personsCount: number | null;
  hasPets: boolean;
  pets: unknown;
  moveReason: string | null;
  additionalComment: string | null;
  // Sebepřiznané (z dotazníku)
  hasExecutions: boolean;
  hasInsolvency: boolean;
  // Reference
  referenceResult: string | null; // positive | neutral | negative | null
  referenceNote: string | null;
  referenceReachable: boolean; // false = nepodařilo se dovolat / bez kontaktu (měkký signál)
  // Registry (oficiální lookup)
  isirResult: string | null;
  ceeResult: string | null;
  // Kontext bytu
  rent: number | null;
  city: string | null;
}

export interface FinalJudgement {
  verdict: FinalVerdict;
  reason: string;
}

const SYSTEM_PROMPT = `Jsi finální AI soudce kvality nájemníka pro českou službu NajdiNájemníka.
Dostaneš kompletní profil uchazeče, který už prošel kaskádou prověření (dotazník → reference → registry).
Tvým úkolem je autonomně rozhodnout, jak silný je to finalista, a vrátit POUZE validní JSON bez markdownu:

{"verdict":"ultra_wow"|"wow"|"reject","reason":"<max 140 znaků česky, pro majitele/admina>"}

Rozhoduj holisticky ze VŠECH dat (příjem vs. nájem, zaměstnání, počet osob, mazlíčci, důvod stěhování,
tón reference, výsledky registrů, sebepřiznané dluhy). Pravidla:

- "ultra_wow": mimořádně silný profil BEZ JEDINÉ výhrady. Čistý ve všech registrech (ISIR i CEE bez záznamu),
  jednoznačně pozitivní reference od předchozího pronajímatele, příjem komfortně nad nájmem, žádné varovné signály.
  Takového člověka pošleme majiteli okamžitě, protože by ho neměl propásnout.

- "wow": solidní, vhodný finalista bez závažných problémů, ale ne mimořádný — nebo silný profil, u kterého
  ale CHYBÍ reference (nepodařilo se dovolat / uchazeč neměl předchozího pronajímatele). Chybějící reference
  není důvod k zamítnutí, jen brání povýšení na ultra_wow.

- "reject": závažný problém — záznam v ISIR nebo CEE, výslovně negativní reference, příjem nedostačující na nájem,
  nebo kombinace varovných signálů.

Buď přísný na ultra_wow (opravdu jen špička). Reason musí stručně vysvětlit verdikt.`;

export async function judgeFinalist(input: FinalJudgeInput): Promise<FinalJudgement> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      verdict: "wow",
      reason: "ANTHROPIC_API_KEY není nastaven — finální verdikt přeskočen, zkontrolujte ručně",
    };
  }

  try {
    const client = new Anthropic();
    const msg = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildFinalJudgePrompt(input) }],
    });

    const text = (msg.content[0] as { type: string; text: string }).text;
    return parseFinalJudgement(text);
  } catch (err) {
    console.error("[finalJudge] Chyba:", err);
    return {
      verdict: "wow",
      reason: "Finální verdikt selhal — zkontrolujte profil ručně",
    };
  }
}

/** Sestaví textový profil uchazeče pro soudce. Čistá funkce — testovatelná. */
export function buildFinalJudgePrompt(input: FinalJudgeInput): string {
  const petsText = input.hasPets ? `ano (${JSON.stringify(input.pets ?? "neuvedeno")})` : "ne";
  const refReach = input.referenceReachable
    ? `výsledek: ${input.referenceResult ?? "neuvedeno"}${input.referenceNote ? ` (${input.referenceNote})` : ""}`
    : "NEDOSTUPNÁ (nepodařilo se dovolat nebo bez kontaktu) — měkký signál, nezamítat kvůli tomu";

  return `PROFIL UCHAZEČE: ${input.name}

PRVOTNÍ AI SCÓRE (z dotazníku): ${input.score ?? "neuvedeno"}/100
Odůvodnění: ${input.scoringReason ?? "neuvedeno"}
AI poznámka: ${input.aiNote ?? "neuvedeno"}

EKONOMIKA:
- Příjem: ${input.income ? `${input.income} Kč/měs` : "neuvedeno"}
- Nájem bytu: ${input.rent ? `${input.rent} Kč/měs` : "neuvedeno"}
- Zaměstnání: ${input.employment ?? "neuvedeno"}
- Počet osob: ${input.personsCount ?? "neuvedeno"}
- Mazlíčci: ${petsText}
- Důvod stěhování: ${input.moveReason ?? "neuvedeno"}
- Doplňující komentář: ${input.additionalComment ?? "neuvedeno"}

SEBEPŘIZNÁNÍ (z dotazníku):
- Exekuce: ${input.hasExecutions ? "ANO přiznáno" : "ne"}
- Insolvence: ${input.hasInsolvency ? "ANO přiznáno" : "ne"}

REFERENCE od předchozího pronajímatele: ${refReach}

OFICIÁLNÍ REGISTRY (lookup):
- ISIR (insolvence): ${input.isirResult ?? "neprovedeno"}
- CEE (exekuce): ${input.ceeResult ?? "neprovedeno"}

Lokalita bytu: ${input.city ?? "neuvedeno"}

Rozhodni verdikt (ultra_wow / wow / reject) a vrať JSON.`;
}

/** Parsuje a validuje odpověď soudce. Čistá funkce — testovatelná. */
export function parseFinalJudgement(text: string): FinalJudgement {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const json = (match ? match[1] : text).trim();
  const parsed = JSON.parse(json) as FinalJudgement;
  if (!["ultra_wow", "wow", "reject"].includes(parsed.verdict)) {
    throw new Error(`Neznámý verdict: ${parsed.verdict}`);
  }
  return { verdict: parsed.verdict, reason: String(parsed.reason ?? "").slice(0, 140) };
}
