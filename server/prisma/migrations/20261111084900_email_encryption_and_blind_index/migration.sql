-- AlterTable
ALTER TABLE "User" ADD COLUMN "emailHash" TEXT;

-- DropIndex
DROP INDEX IF EXISTS "User_email_key";

-- CreateIndex
CREATE UNIQUE INDEX "User_emailHash_key" ON "User"("emailHash");
