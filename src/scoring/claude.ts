import Anthropic from "@anthropic-ai/sdk";
import {
  SCORING_SYSTEM_PROMPT,
  ScoringInput,
  ScoringResult,
  buildScoringPrompt,
} from "./prompt";

const client = new Anthropic();

export async function scoreApplicant(input: ScoringInput): Promise<ScoringResult> {
  const message = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 512,
    system: SCORING_SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildScoringPrompt(input) }],
  });

  const text = (message.content[0] as { type: string; text: string }).text;

  try {
    const result = JSON.parse(text) as ScoringResult;
    // Clamp score to 0-100
    result.score = Math.max(0, Math.min(100, Math.round(result.score)));
    return result;
  } catch {
    throw new Error(`Claude vrátil neplatný JSON: ${text.slice(0, 200)}`);
  }
}
