/**
 * AI vyhodnocení přepisu referenčního hovoru s předchozím pronajímatelem.
 * Používá Claude Haiku (rychlý, levný) — stačí na jednoduchý sentiment + shrnutí.
 */

import Anthropic from "@anthropic-ai/sdk";

export type ReferenceResult = "positive" | "neutral" | "negative";

export interface ReferenceEvaluation {
  result: ReferenceResult;
  note: string;
}

const SYSTEM_PROMPT = `Jsi asistent hodnotící přepis reference od předchozího pronajímatele v ČR.
Analyzuj přepis a vrať POUZE validní JSON, bez markdown, bez komentářů.

Formát:
{"result":"positive"|"neutral"|"negative","note":"<max 100 znaků česky>"}

Pravidla hodnocení:
- positive: platil včas, žádné problémy, pronajímatel doporučuje nebo se vyjadřuje kladně
- neutral: bez závažných problémů ale bez nadšení, nebo nedostatečné informace, nebo hovor nebyl dokončen
- negative: problémy s platbami, poškození bytu, konflikty, výslovné nedoporučení

Pokud přepis je prázdný, krátký nebo nedošlo ke smysluplnému rozhovoru → neutral.
Note musí být stručná věta pro admina, max 100 znaků.`;

export async function evaluateReferenceTranscript(
  transcript: string
): Promise<ReferenceEvaluation> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      result: "neutral",
      note: "ANTHROPIC_API_KEY není nastaven — vyhodnocení přeskočeno, zkontrolujte ručně",
    };
  }

  try {
    const client = new Anthropic();
    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 150,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Přepis hovoru s předchozím pronajímatelem:\n\n${transcript.slice(0, 3000)}`,
        },
      ],
    });

    const text = (msg.content[0] as { type: string; text: string }).text.trim();
    const parsed = JSON.parse(text) as ReferenceEvaluation;

    if (!["positive", "neutral", "negative"].includes(parsed.result)) {
      throw new Error(`Neznámý result: ${parsed.result}`);
    }

    return parsed;
  } catch (err) {
    console.error("[reference/evaluate] Chyba:", err);
    return {
      result: "neutral",
      note: "Vyhodnocení selhalo — zkontrolujte přepis ručně",
    };
  }
}
