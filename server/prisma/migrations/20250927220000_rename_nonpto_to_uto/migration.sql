-- Rename Non-PTO columns to UTO terminology (idempotent for already-migrated databases)

DO $$
BEGIN
  ALTER TABLE "PtoBalance" RENAME COLUMN "nonPtoHours" TO "utoHours";
EXCEPTION
  WHEN undefined_column THEN
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'PtoBalance' AND column_name = 'utoHours'
    ) THEN
      RAISE;
    END IF;
END $$;

DO $$
BEGIN
  ALTER TABLE "PtoBalance" RENAME COLUMN "baseNonPtoHours" TO "baseUtoHours";
EXCEPTION
  WHEN undefined_column THEN
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'PtoBalance' AND column_name = 'baseUtoHours'
    ) THEN
      RAISE;
    END IF;
END $$;

DO $$
BEGIN
  ALTER TABLE "EmployeeCompConfig" RENAME COLUMN "nonPtoBalanceHours" TO "utoBalanceHours";
EXCEPTION
  WHEN undefined_column THEN
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'EmployeeCompConfig' AND column_name = 'utoBalanceHours'
    ) THEN
      RAISE;
    END IF;
END $$;

DO $$
BEGIN
  ALTER TABLE "AttendanceMonthFact" RENAME COLUMN "nonPtoAbsenceHours" TO "utoAbsenceHours";
EXCEPTION
  WHEN undefined_column THEN
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'AttendanceMonthFact' AND column_name = 'utoAbsenceHours'
    ) THEN
      RAISE;
    END IF;
END $$;
