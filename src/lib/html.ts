/**
 * Escapuje HTML speciální znaky. Jména/poznámky pocházejí od uživatelů a jdou
 * do HTML e-mailů — bez escapování by šlo injektovat libovolné HTML
 * (phishingové odkazy, falešný obsah). Escapujeme u zdroje interpolace.
 */
export function escapeHtml(input: string | null | undefined): string {
  if (input == null) return "";
  return String(input)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
