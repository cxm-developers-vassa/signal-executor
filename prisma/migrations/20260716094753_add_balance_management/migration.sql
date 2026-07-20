-- AlterTable
ALTER TABLE `BotConfig` ADD COLUMN `autoUpdateBalance` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `maxDrawdownPercent` DECIMAL(10, 4) NULL,
    ADD COLUMN `startBalance` DECIMAL(20, 2) NULL;
