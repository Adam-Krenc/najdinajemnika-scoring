/**
 * Pipeline status logika pro AI scoring.
 * Čisté funkce — žádné side-effecty, snadno testovatelné.
 */

/**
 * Minimální skóre „velmi atraktivní" — gate 1 kaskády. Jen uchazeči nad tímto
 * prahem postupují na referenční hovor (drahý krok), ostatní → rejected_ai.
 * Zvýšeno z 50 na 75, aby reference volala jen na opravdu silné profily.
 */
export const SCORE_THRESHOLD = 75;

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
