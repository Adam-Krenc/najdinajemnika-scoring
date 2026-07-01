import Anthropic from "@anthropic-ai/sdk";
import {
  SCORING_SYSTEM_PROMPT,
  ScoringInput,
  ScoringResult,
  buildScoringPrompt,
} from "./prompt";

const client = new Anthropic();

export function extractJSON(text: string): string {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) return match[1].trim();
  return text.trim();
}

/**
 * Parsuje a normalizuje textovou odpověď Claude do ScoringResult.
 * Čistá funkce bez síťového volání — testovatelná samostatně.
 */
export function parseScoringResponse(text: string): ScoringResult {
  try {
    const result = JSON.parse(extractJSON(text)) as ScoringResult;
    // Clamp score to 0-100
    result.score = Math.max(0, Math.min(100, Math.round(result.score)));
    return result;
  } catch {
    throw new Error(`Claude vrátil neplatný JSON: ${text.slice(0, 200)}`);
  }
}

export async function scoreApplicant(input: ScoringInput): Promise<ScoringResult> {
  const message = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 1024,
    system: SCORING_SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildScoringPrompt(input) }],
  });

  const text = (message.content[0] as { type: string; text: string }).text;
  return parseScoringResponse(text);
}
