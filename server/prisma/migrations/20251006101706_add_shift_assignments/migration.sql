-- CreateTable
CREATE TABLE "ShiftAssignment" (
    "id" SERIAL PRIMARY KEY,
    "userId" INTEGER NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "ShiftAssignment_userId_startsAt_idx" ON "ShiftAssignment"("userId", "startsAt");
CREATE INDEX "ShiftAssignment_userId_endsAt_idx" ON "ShiftAssignment"("userId", "endsAt");

-- AddForeignKey
ALTER TABLE "ShiftAssignment"
  ADD CONSTRAINT "ShiftAssignment_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
