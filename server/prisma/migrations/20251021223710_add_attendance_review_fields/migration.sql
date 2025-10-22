-- Add attendance review workflow fields
CREATE TYPE "AttendanceReviewStatus" AS ENUM ('pending', 'resolved');

ALTER TABLE "AttendanceMonthFact"
  ADD COLUMN "reviewStatus" "AttendanceReviewStatus" NOT NULL DEFAULT 'pending',
  ADD COLUMN "reviewNotes" TEXT,
  ADD COLUMN "reviewedAt" TIMESTAMP(3),
  ADD COLUMN "reviewedById" INTEGER;

ALTER TABLE "AttendanceMonthFact"
  ADD CONSTRAINT "AttendanceMonthFact_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
