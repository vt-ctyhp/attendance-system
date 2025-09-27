-- CreateTable
CREATE TABLE "TimesheetEditRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" INTEGER NOT NULL,
    "view" TEXT NOT NULL,
    "periodStart" DATETIME NOT NULL,
    "periodEnd" DATETIME NOT NULL,
    "targetDate" DATETIME NOT NULL,
    "requestedMinutes" INTEGER,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewerId" INTEGER,
    "adminNote" TEXT,
    "reviewedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TimesheetEditRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TimesheetEditRequest_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "TimesheetEditRequest_userId_idx" ON "TimesheetEditRequest"("userId");

-- CreateIndex
CREATE INDEX "TimesheetEditRequest_status_idx" ON "TimesheetEditRequest"("status");

-- CreateIndex
CREATE INDEX "TimesheetEditRequest_periodStart_periodEnd_idx" ON "TimesheetEditRequest"("periodStart", "periodEnd");
