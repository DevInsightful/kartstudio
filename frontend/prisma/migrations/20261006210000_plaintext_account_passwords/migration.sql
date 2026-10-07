-- CredentialRecord was empty when this migration was prepared.
DROP INDEX "CredentialRecord_accountId_key";
DROP TABLE "CredentialRecord";

CREATE TABLE "CredentialRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" INTEGER NOT NULL,
    "username" TEXT,
    "password" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CredentialRecord_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "CredentialRecord_accountId_key" ON "CredentialRecord"("accountId");
