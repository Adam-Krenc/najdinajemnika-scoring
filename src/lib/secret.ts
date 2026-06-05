import { timingSafeEqual } from "crypto";

/**
 * Časově konstantní porovnání dvou řetězců (ochrana proti timing útoku).
 * Vrací false při rozdílné délce — bez early-return na prvním odlišném znaku.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
