-- AlterTable
ALTER TABLE "PtoBalance" ADD COLUMN "lastAccrualMonth" TEXT;

-- CreateTable
CREATE TABLE "AccrualRule" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "hoursPerMonth" REAL NOT NULL,
    "startDate" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AccrualRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_TimeRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "startDate" DATETIME NOT NULL,
    "endDate" DATETIME NOT NULL,
    "hours" REAL NOT NULL,
    "reason" TEXT,
    "approverId" INTEGER,
    "approvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TimeRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TimeRequest_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_TimeRequest" ("approvedAt", "approverId", "createdAt", "endDate", "hours", "id", "reason", "startDate", "status", "type", "updatedAt", "userId") SELECT "approvedAt", "approverId", "createdAt", "endDate", "hours", "id", "reason", "startDate", "status", "type", "updatedAt", "userId" FROM "TimeRequest";
DROP TABLE "TimeRequest";
ALTER TABLE "new_TimeRequest" RENAME TO "TimeRequest";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "AccrualRule_userId_key" ON "AccrualRule"("userId");
