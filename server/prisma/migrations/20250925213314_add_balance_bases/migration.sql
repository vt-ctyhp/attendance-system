-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PtoBalance" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "basePtoHours" REAL NOT NULL DEFAULT 0,
    "baseNonPtoHours" REAL NOT NULL DEFAULT 0,
    "baseMakeUpHours" REAL NOT NULL DEFAULT 0,
    "ptoHours" REAL NOT NULL DEFAULT 0,
    "nonPtoHours" REAL NOT NULL DEFAULT 0,
    "makeUpHours" REAL NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PtoBalance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_PtoBalance" ("createdAt", "id", "makeUpHours", "nonPtoHours", "ptoHours", "updatedAt", "userId") SELECT "createdAt", "id", "makeUpHours", "nonPtoHours", "ptoHours", "updatedAt", "userId" FROM "PtoBalance";
DROP TABLE "PtoBalance";
ALTER TABLE "new_PtoBalance" RENAME TO "PtoBalance";
CREATE UNIQUE INDEX "PtoBalance_userId_key" ON "PtoBalance"("userId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
