-- Add submitted metadata columns to EmployeeCompConfig
ALTER TABLE "EmployeeCompConfig"
  ADD COLUMN "submittedById" INTEGER,
  ADD COLUMN "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "EmployeeCompConfig"
  ADD CONSTRAINT "EmployeeCompConfig_submittedById_fkey"
  FOREIGN KEY ("submittedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
