import Anthropic from "@anthropic-ai/sdk";
import { AD_SYSTEM_PROMPT, AdInput, AdResult, buildAdPrompt } from "./adPrompt";

const client = new Anthropic();

export async function generateAd(input: AdInput): Promise<AdResult> {
  const message = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 1024,
    system: AD_SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildAdPrompt(input) }],
  });

  const text = (message.content[0] as { type: string; text: string }).text;

  try {
    return JSON.parse(text) as AdResult;
  } catch {
    throw new Error(`Claude vrátil neplatný JSON: ${text.slice(0, 200)}`);
  }
}
