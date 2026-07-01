-- Kaskáda prověřování: finální AI verdikt na konci pipeline.
-- Idempotentní, nedestruktivní (nullable sloupce) — bezpečné na produkční sdílené DB.
ALTER TABLE "Applicant" ADD COLUMN IF NOT EXISTS "finalVerdict" TEXT;
ALTER TABLE "Applicant" ADD COLUMN IF NOT EXISTS "finalReason" TEXT;
ALTER TABLE "Applicant" ADD COLUMN IF NOT EXISTS "finalJudgedAt" TIMESTAMP(3);
