-- CreateTable
CREATE TABLE `BotConfig` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `budget` DECIMAL(20, 8) NOT NULL,
    `conflictStrategy` ENUM('CONSERVATIVE', 'AGGRESSIVE') NOT NULL DEFAULT 'CONSERVATIVE',
    `isActive` BOOLEAN NOT NULL DEFAULT false,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SymbolConfig` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `symbol` VARCHAR(20) NOT NULL,
    `isEnabled` BOOLEAN NOT NULL DEFAULT true,
    `leverage` INTEGER NOT NULL,
    `budgetPercent` DECIMAL(10, 4) NOT NULL,
    `entryPriceOffsetPercent` DECIMAL(10, 4) NOT NULL,
    `repriceThresholdPercent` DECIMAL(10, 4) NOT NULL,
    `entryTimeoutSec` INTEGER NOT NULL,
    `takeProfitPercent` DECIMAL(10, 4) NOT NULL,
    `stopLossPercent` DECIMAL(10, 4) NOT NULL,
    `safetyTpPercent` DECIMAL(10, 4) NOT NULL,
    `safetySlPercent` DECIMAL(10, 4) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SymbolConfig_symbol_key`(`symbol`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Trade` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `signalId` INTEGER NOT NULL,
    `symbol` VARCHAR(20) NOT NULL,
    `side` ENUM('LONG', 'SHORT') NOT NULL,
    `status` ENUM('ENTERING', 'OPEN', 'CLOSING', 'CLOSED', 'CANCELLED', 'FAILED') NOT NULL DEFAULT 'ENTERING',
    `targetQuantity` DECIMAL(20, 8) NOT NULL,
    `filledQuantity` DECIMAL(20, 8) NOT NULL DEFAULT 0,
    `avgEntryPrice` DECIMAL(20, 8) NULL,
    `budgetPercent` DECIMAL(10, 4) NOT NULL,
    `leverage` INTEGER NOT NULL,
    `positionId` VARCHAR(40) NULL,
    `takeProfitPrice` DECIMAL(20, 8) NULL,
    `stopLossPrice` DECIMAL(20, 8) NULL,
    `entryDeadline` DATETIME(3) NULL,
    `realizedPnl` DECIMAL(20, 8) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Trade_signalId_key`(`signalId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Order` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `tradeId` INTEGER NOT NULL,
    `bingxOrderId` VARCHAR(40) NOT NULL,
    `purpose` ENUM('ENTRY', 'CLOSE', 'SAFETY_TP', 'SAFETY_SL') NOT NULL,
    `type` ENUM('LIMIT', 'TAKE_PROFIT_MARKET', 'STOP_MARKET') NOT NULL,
    `side` ENUM('BUY', 'SELL') NOT NULL,
    `positionSide` ENUM('LONG', 'SHORT') NOT NULL,
    `price` DECIMAL(20, 8) NOT NULL,
    `quantity` DECIMAL(20, 8) NOT NULL,
    `status` ENUM('NEW', 'PENDING', 'FILLED', 'PARTIALLYFILLED', 'CANCELLED', 'FAILED') NOT NULL DEFAULT 'NEW',
    `executedQty` DECIMAL(20, 8) NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Trade` ADD CONSTRAINT `Trade_signalId_fkey` FOREIGN KEY (`signalId`) REFERENCES `Signal`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Order` ADD CONSTRAINT `Order_tradeId_fkey` FOREIGN KEY (`tradeId`) REFERENCES `Trade`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
