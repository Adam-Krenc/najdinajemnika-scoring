/**
 * Pipeline status logika pro AI scoring.
 * Čisté funkce — žádné side-effecty, snadno testovatelné.
 */

/** Minimální skóre, při kterém uchazeč postupuje dál (jinak rejected_ai). */
export const SCORE_THRESHOLD = 50;

export type ScoringStatus = "awaiting_reference" | "rejected_ai";

/**
 * Rozhodne, do jakého stavu přejde uchazeč po AI scoringu.
 * score >= threshold → awaiting_reference, jinak rejected_ai.
 */
export function determineScoringStatus(
  score: number,
  threshold: number = SCORE_THRESHOLD
): ScoringStatus {
  return score >= threshold ? "awaiting_reference" : "rejected_ai";
}
