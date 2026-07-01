import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BingxService } from '../bingx/bingx.service';
import { roundToPrecision } from './trading.utils';

@Injectable()
export class SignalProcessorService {
  private readonly logger = new Logger(SignalProcessorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bingx: BingxService,
  ) {}

  async processNewSignals() {
    const botConfig = await this.prisma.botConfig.findUnique({ where: { id: 1 } });
    if (!botConfig || !botConfig.isActive) {
      this.logger.warn('Бот выключен (isActive=false), сигналы не обрабатываются');
      return;
    }

    const newSignals = await this.prisma.signal.findMany({
      where: { status: 'NEW' },
    });

    for (const signal of newSignals) {
      await this.createTradeFromSignal(signal, Number(botConfig.budget));
    }
  }

  private async createTradeFromSignal(
    signal: { id: number; symbol: string; side: 'LONG' | 'SHORT' },
    budget: number,
  ) {
    const config = await this.prisma.symbolConfig.findUnique({
      where: { symbol: signal.symbol },
    });

    if (!config || !config.isEnabled) {
      this.logger.warn(`Нет активной настройки для ${signal.symbol}, сигнал #${signal.id} отклонён`);
      await this.prisma.signal.update({
        where: { id: signal.id },
        data: { status: 'CANCELLED' },
      });
      return;
    }

    const ticker = await this.bingx.getPrice(signal.symbol);
    const currentPrice = Number(ticker.data.price);

    const budgetPercent = Number(config.budgetPercent);
    const leverage = config.leverage;
    const margin = budget * (budgetPercent / 100);
    const nominal = margin * leverage;
    const rawQuantity = nominal / currentPrice;

    const contractInfo = await this.bingx.getContractInfo(signal.symbol);
    const quantityPrecision = contractInfo.data[0].quantityPrecision;
    const targetQuantity = roundToPrecision(rawQuantity, quantityPrecision);

    this.logger.log(
      `Сигнал #${signal.id} ${signal.symbol} ${signal.side}: ` +
      `цена=${currentPrice}, маржа=${margin}, номинал=${nominal}, qty=${targetQuantity}`,
    );

    const deadline = new Date(Date.now() + config.entryTimeoutSec * 1000);

    await this.prisma.trade.create({
      data: {
        signalId: signal.id,
        symbol: signal.symbol,
        side: signal.side,
        status: 'ENTERING',
        targetQuantity,
        budgetPercent: config.budgetPercent,
        leverage,
        entryDeadline: deadline,
      },
    });

    await this.prisma.signal.update({
      where: { id: signal.id },
      data: { status: 'PROCESSING' },
    });

    this.logger.log(`Создана сделка для сигнала #${signal.id}, статус ENTERING`);
  }
}