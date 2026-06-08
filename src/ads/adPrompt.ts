export const AD_SYSTEM_PROMPT = `Jsi zkušený copywriter specializující se na pronájmy nemovitostí v České republice. Vrátíš POUZE validní JSON bez markdown, bez komentářů.

Piš přirozeně, bez reklamního newspeaku. Zdůrazni klíčové výhody bytu. Styl musí působit lidsky a důvěryhodně.
Nepoužívej pomlčky "–" ani "—" jako ozdobné prvky. Místo nich používej čárky nebo tečky.

Vrať POUZE tento JSON (žádný jiný text):
{
  "headline": "<nadpis max 60 znaků, bez interpunkce na konci>",
  "text": "<inzerát 150–250 slov, přirozený český jazyk, strukturovaný odstavci>"
}`;

export interface AdInput {
  listing: {
    street: string;
    city: string;
    zip?: string | null;
    size: string;
    rent: number;
    description?: string | null;
    maxPersons: number;
    petsAllowed: string;
    smokingAllowed: boolean;
    tenantPref: string;
    photos?: string[] | null;
    availableFrom?: Date | string | null;
    contactPhone?: string | null;
  };
}

export interface AdResult {
  headline: string;
  text: string;
}

export function buildAdPrompt(input: AdInput): string {
  const { listing } = input;
  const phone = listing.contactPhone ?? process.env.VAPI_PHONE ?? "+420 XXX XXX XXX";
  const availableDate = listing.availableFrom
    ? new Date(listing.availableFrom).toLocaleDateString("cs-CZ", { day: "numeric", month: "long", year: "numeric" })
    : "ihned";
  const photoCount = listing.photos?.length ?? 0;

  return `BYT K PRONÁJMU:
  Adresa: ${listing.street}, ${listing.city}${listing.zip ? ` ${listing.zip}` : ""}
  Velikost: ${listing.size}
  Nájem: ${listing.rent} Kč/měs
  Dostupné od: ${availableDate}
  Max. osob: ${listing.maxPersons}
  Mazlíčci: ${listing.petsAllowed}
  Kouření: ${listing.smokingAllowed ? "povoleno" : "zakázáno"}
  Preference nájemníka: ${listing.tenantPref}
  ${photoCount > 0 ? `Fotografie: ${photoCount} fotek` : ""}
  ${listing.description ? `Popis od majitele: ${listing.description}` : ""}

Na konci inzerátu přidej: "Zájem? Volejte ${phone} nebo vyplňte formulář na najdinajemnika.cz"`;
}
