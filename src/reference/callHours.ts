/**
 * Volací okno pro referenční hovory — voláme pronajímatelům jen v rozumnou dobu.
 * Čisté funkce, testovatelné (viz __tests__/callHours.test.ts).
 */

/** Volací okno: hodina spadá do 9:00–16:59 (tj. 9 ≤ hour < 17). */
export function isWithinCallHours(hour: number): boolean {
  return hour >= 9 && hour < 17;
}

/** Vrátí true pokud je aktuálně 9:00–17:00 pražského času. */
export function isCallHour(): boolean {
  const formatter = new Intl.DateTimeFormat("cs-CZ", {
    timeZone: "Europe/Prague",
    hour: "numeric",
    hour12: false,
  });
  const hour = parseInt(formatter.format(new Date()), 10);
  return isWithinCallHours(hour);
}
