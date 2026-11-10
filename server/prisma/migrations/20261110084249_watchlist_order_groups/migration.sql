-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_WatchlistItem" (
    "symbol" TEXT NOT NULL PRIMARY KEY,
    "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "position" INTEGER NOT NULL DEFAULT 0,
    "group" TEXT
);
INSERT INTO "new_WatchlistItem" ("addedAt", "symbol") SELECT "addedAt", "symbol" FROM "WatchlistItem";
DROP TABLE "WatchlistItem";
ALTER TABLE "new_WatchlistItem" RENAME TO "WatchlistItem";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- Keep the existing order: number current items by when they were added.
UPDATE "WatchlistItem" SET "position" = (
    SELECT COUNT(*) FROM "WatchlistItem" AS w2
    WHERE w2."addedAt" < "WatchlistItem"."addedAt"
       OR (w2."addedAt" = "WatchlistItem"."addedAt" AND w2."symbol" < "WatchlistItem"."symbol")
);
