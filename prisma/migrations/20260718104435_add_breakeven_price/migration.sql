-- AlterTable
ALTER TABLE `Trade` ADD COLUMN `breakevenPrice` DECIMAL(20, 8) NULL,
    MODIFY `closeMode` ENUM('PROFIT', 'LOSS', 'BREAKEVEN') NULL;
