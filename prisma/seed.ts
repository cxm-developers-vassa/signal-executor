import { PrismaClient } from '../generated/prisma/client';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import 'dotenv/config';

const adapter = new PrismaMariaDb({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

const prisma = new PrismaClient({ adapter });

async function main() {
  // 1. Глобальная настройка бота
  await prisma.botConfig.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      budget: 100,
      conflictStrategy: 'CONSERVATIVE',
      isActive: false,
    },
  });

  // 2. Настройки символов
  const symbols = ['BTC-USDT','SOL-USDT', 'XRP-USDT'];

  for (const symbol of symbols) {
    await prisma.symbolConfig.upsert({
      where: { symbol },
      update: {},
      create: {
        symbol,
        isEnabled: true,
        leverage: 5,
        budgetPercent: 100,
        entryPriceOffsetPercent: 0.01,
        repriceThresholdPercent: 0.02,
        entryTimeoutSec: 900,
        takeProfitPercent: 0.55,
        stopLossPercent: 0.55,
        safetyTpPercent: 0.7,
        safetySlPercent: 0.7,
      },
    });
  }

  console.log('Seed выполнен: BotConfig + настройки символов');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });