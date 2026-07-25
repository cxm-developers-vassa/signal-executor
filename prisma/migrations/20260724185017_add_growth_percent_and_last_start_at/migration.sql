-- AlterTable
ALTER TABLE `BotConfig` ADD COLUMN `lastStartAt` DATETIME(3) NULL,
    ADD COLUMN `maxGrowthPercent` DECIMAL(10, 4) NULL;
