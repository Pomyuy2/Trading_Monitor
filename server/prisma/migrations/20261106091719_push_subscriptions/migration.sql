-- CreateTable
CREATE TABLE "PushSubscription" (
    "endpoint" TEXT NOT NULL PRIMARY KEY,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "lang" TEXT NOT NULL DEFAULT 'en',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
