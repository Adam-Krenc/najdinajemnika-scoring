export const AD_SYSTEM_PROMPT = `Jsi zkušený copywriter specializující se na pronájmy nemovitostí v České republice. Vrátíš POUZE validní JSON bez markdown, bez komentářů.

Piš přirozeně, bez reklamního newspeaku. Zdůrazni klíčové výhody bytu. Styl musí působit lidsky a důvěryhodně.

Vrať POUZE tento JSON (žádný jiný text):
{
  "headline": "<nadpis max 60 znaků, bez interpunkce na konci>",
  "text": "<inzerát 150–250 slov, přirozený český jazyk, strukturovaný odstavci>"
}`;

export interface AdInput {
  listing: {
    street: string;
    city: string;
    zip: string;
    size: string;
    rent: number;
    description?: string | null;
    maxPersons: number;
    petsAllowed: string;
    smokingAllowed: boolean;
    tenantPref: string;
    photos: string[];
    availableFrom: Date | string;
    contactPhone?: string | null;
  };
}

export interface AdResult {
  headline: string;
  text: string;
}

export function buildAdPrompt(input: AdInput): string {
  const { listing } = input;
  const phone = listing.contactPhone ?? "+420 XXX XXX XXX";
  const availableDate = new Date(listing.availableFrom).toLocaleDateString("cs-CZ", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  return `BYT K PRONÁJMU:
  Adresa: ${listing.street}, ${listing.city} ${listing.zip}
  Velikost: ${listing.size}
  Nájem: ${listing.rent} Kč/měs
  Dostupné od: ${availableDate}
  Max. osob: ${listing.maxPersons}
  Mazlíčci: ${listing.petsAllowed}
  Kouření: ${listing.smokingAllowed ? "povoleno" : "zakázáno"}
  Preference nájemníka: ${listing.tenantPref}
  Fotografie: ${listing.photos.length} fotek
  ${listing.description ? `Popis od majitele: ${listing.description}` : ""}

Na konci inzerátu přidej: "Zájem? Volejte ${phone} nebo vyplňte formulář na najdinajemnika.cz"`;
}
