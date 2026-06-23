/**
 * Čisté mapování DB řádků → ScoringInput pro recovery sweeper.
 *
 * Záměrně oddělené od `recover.ts`, aby tahle logika šla unit-testovat bez
 * tažení Prisma klienta / webhook routeru (ty drží otevřené handly a bránily by
 * čistému ukončení testovacího procesu).
 */
import type { ScoringInput } from "./prompt";

/** Výchozí stáří, po kterém je `new` uchazeč považován za uvízlého. */
export const DEFAULT_STUCK_MINUTES = 10;
/** Strop, kolik uvízlých uchazečů zpracovat v jednom běhu (ochrana proti zahlcení). */
export const DEFAULT_BATCH_LIMIT = 25;

/** Minimální tvar Applicant řádku, který sweeper potřebuje pro scoring. */
export interface StuckApplicantRow {
  dateOfBirth?: string | null;
  income?: number | null;
  employment?: string | null;
  incomeProofUrl?: string | null;
  personsCount?: number | null;
  hasPets: boolean;
  moveReason?: string | null;
  hasExecutions?: boolean | null;
  executionDebt?: string | null;
  executionComment?: string | null;
  hasInsolvency?: boolean | null;
  insolvencyDebt?: string | null;
  insolvencyComment?: string | null;
  message?: string | null;
  additionalComment?: string | null;
}

/** Minimální tvar Listing řádku pro scoring. */
export interface StuckListingRow {
  city: string;
  size: string;
  rent: number;
  maxPersons: number;
  petsAllowed: string;
  tenantPref: string;
}

/**
 * Poskládá `ScoringInput` z DB řádků Applicant + Listing.
 *
 * Mapování záměrně zrcadlí `app/api/leads/route.ts` (kanonický scoring payload),
 * tedy bez `householdMembers` a detailního pole `pets` — předává se jen `hasPets`.
 * Tím má zachráněný uchazeč identické skóre, jako kdyby živý trigger uspěl.
 *
 * Čistá funkce bez side-effectů — testovatelná samostatně.
 */
export function buildScoringInput(
  applicant: StuckApplicantRow,
  listing: StuckListingRow
): ScoringInput {
  return {
    listing: {
      city: listing.city,
      size: listing.size,
      rent: listing.rent,
      maxPersons: listing.maxPersons,
      petsAllowed: listing.petsAllowed,
      tenantPref: listing.tenantPref,
    },
    applicant: {
      dateOfBirth: applicant.dateOfBirth ?? null,
      income: applicant.income ?? null,
      employment: applicant.employment ?? null,
      incomeProofUrl: applicant.incomeProofUrl ?? null,
      personsCount: applicant.personsCount ?? null,
      hasPets: applicant.hasPets,
      moveReason: applicant.moveReason ?? null,
      hasExecutions: applicant.hasExecutions ?? false,
      executionDebt: applicant.executionDebt ?? null,
      executionComment: applicant.executionComment ?? null,
      hasInsolvency: applicant.hasInsolvency ?? false,
      insolvencyDebt: applicant.insolvencyDebt ?? null,
      insolvencyComment: applicant.insolvencyComment ?? null,
      message: applicant.message ?? null,
      additionalComment: applicant.additionalComment ?? null,
    },
  };
}
