import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BingxService } from '../bingx/bingx.service';
import { roundToPrecision } from './trading.utils';

@Injectable()
export class SignalProcessorService {
  private readonly logger = new Logger(SignalProcessorService.name);
  private waitingLogged = new Set<number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly bingx: BingxService,
  ) {}

  
async processNewSignals(allPositions: any[]) {
    const botConfig = await this.prisma.botConfig.findUnique({ where: { id: 1 } });
    if (!botConfig || !botConfig.isActive) {
      return;
    }

    const newSignals = await this.prisma.signal.findMany({
      where: { status: 'NEW' },
      orderBy: { createdAt: 'asc' }, // старые сигналы первыми (справедливая очередь)
    });

    if (newSignals.length === 0) return;

    const budget = Number(botConfig.budget);

    // Считаем занятый бюджет по активным сделкам
    const activeTrades = await this.prisma.trade.findMany({
      where: { status: { in: ['ENTERING', 'OPEN', 'CLOSING'] } },
    });
    const usedBudget = activeTrades.reduce(
      (sum, t) => sum + budget * (Number(t.budgetPercent) / 100),
      0,
    );
    const freeBudget = budget - usedBudget;

    for (const signal of newSignals) {
      await this.handleSignal(signal, botConfig, budget, freeBudget, activeTrades, allPositions);
    }
  }

  private async handleSignal(
    signal: any,
    botConfig: any,
    budget: number,
    freeBudget: number,
    activeTrades: any[],
    allPositions: any[],
  ) {
    const config = await this.prisma.symbolConfig.findUnique({
      where: { symbol: signal.symbol },
    });

    if (!config || !config.isEnabled) {
      this.logger.warn(`Нет активной настройки для ${signal.symbol}, сигнал #${signal.id} отклонён`);
      await this.cancelSignal(signal.id);
      return;
    }

    // ШАГ 0 — дубль? (позиция по символу в ту же сторону)
    const sameSideTrade = activeTrades.find(
      (t) => t.symbol === signal.symbol && t.side === signal.side,
    );
    if (sameSideTrade) {
      this.logger.warn(`Сигнал #${signal.id} ${signal.symbol} ${signal.side}: дубль (позиция уже есть) → отмена`);
      await this.cancelSignal(signal.id);
      return;
    }

    // ШАГ 1 — разворот? (позиция по символу в противоположную сторону)
    const oppositeSide = signal.side === 'LONG' ? 'SHORT' : 'LONG';
    const oppositeTrade = activeTrades.find(
      (t) => t.symbol === signal.symbol && t.side === oppositeSide,
    );
    if (oppositeTrade) {
      // Разворот — реализуем в Части 2. Пока: сигнал ждёт (не трогаем).
      await this.handleReversal(signal, oppositeTrade, botConfig, config, allPositions);
      // this.logger.log(`Сигнал #${signal.id} ${signal.symbol}: разворот (есть ${oppositeSide}) — ждёт (Часть 2)`);
      // await this.checkSignalTimeout(signal, config);
      return;
    }

    // ШАГ 2 — новый символ: вопрос бюджета
    const requiredMargin = budget * (Number(config.budgetPercent) / 100);

    if (requiredMargin <= freeBudget) {
      // Хватает — открываем
      await this.createTradeFromSignal(signal, config, budget);
    } else {
      // Не хватает — очередь (Часть 3 добавит закрытия по тактике)
      if (!this.waitingLogged.has(signal.id)) {        
      this.logger.log(
        `Сигнал #${signal.id} ${signal.symbol}: не хватает бюджета ` +
        `(нужно ${requiredMargin.toFixed(2)}, свободно ${freeBudget.toFixed(2)}) — ждёт`,        
      );
      this.waitingLogged.add(signal.id);
      }
      await this.checkSignalTimeout(signal, config);
    }
  }


private async handleReversal(
    signal: any,
    oppositeTrade: any,
    botConfig: any,
    config: any,
    allPositions: any[],
  ) {
    // Если противоположная сделка уже закрывается — просто ждём
    if (oppositeTrade.status === 'CLOSING') {
      await this.checkSignalTimeout(signal, config);
      return;
    }

    const strategy = botConfig.conflictStrategy; // AGGRESSIVE / BALANCED / CONSERVATIVE

    // CONSERVATIVE — не трогаем, ждём
    if (strategy === 'CONSERVATIVE') {
      if (!this.waitingLogged.has(signal.id)) {
        this.logger.log(
          `Сигнал #${signal.id} ${signal.symbol}: разворот, но стратегия CONSERVATIVE — жду закрытия ${oppositeTrade.side}`,
        );
        this.waitingLogged.add(signal.id);
      }
      await this.checkSignalTimeout(signal, config);
      return;
    }

    // Для BALANCED — закрываем только если противоположная в плюсе
    if (strategy === 'BALANCED') {
      const position = allPositions.find(
        (p: any) =>
          p.symbol === oppositeTrade.symbol &&
          p.positionSide === oppositeTrade.side &&
          Number(p.positionAmt) !== 0,
      );
      const unrealizedProfit = position ? Number(position.unrealizedProfit) : 0;

      if (unrealizedProfit < 0) {
        // В минусе — не закрываем, ждём
        if (!this.waitingLogged.has(signal.id)) {
          this.logger.log(
            `Сигнал #${signal.id} ${signal.symbol}: разворот, BALANCED, но ${oppositeTrade.side} в минусе (${unrealizedProfit.toFixed(2)}) — жду`,
          );
          this.waitingLogged.add(signal.id);
        }
        await this.checkSignalTimeout(signal, config);
        return;
      }
    }

    // AGGRESSIVE (всегда) или BALANCED (в плюсе) → закрываем противоположную
    this.logger.log(
      `Сигнал #${signal.id} ${signal.symbol}: разворот (${strategy}) → закрываю ${oppositeTrade.side} #${oppositeTrade.id}`,
    );
    await this.forceCloseTrade(oppositeTrade);
    // сигнал остаётся NEW, ждёт закрытия; откроется на следующем тике, когда бюджет освободится
    await this.checkSignalTimeout(signal, config);
  }

  // Принудительное закрытие сделки (перевод в LOSS-выход)
  private async forceCloseTrade(trade: any) {
    await this.prisma.trade.update({
      where: { id: trade.id },
      data: { status: 'CLOSING', closeMode: 'LOSS' },
    });
    this.logger.log(`Trade #${trade.id} ${trade.symbol}: помечена на принудительное закрытие (LOSS-выход)`);
  }


  private async checkSignalTimeout(signal: any, config: any) {
    const deadline = new Date(
      new Date(signal.createdAt).getTime() + config.entryTimeoutSec * 1000,
    );
    if (new Date() > deadline) {
      this.logger.warn(`Сигнал #${signal.id} ${signal.symbol}: истёк таймаут ожидания → отмена`);
      await this.cancelSignal(signal.id);
    }
  }

  private async cancelSignal(signalId: number) {
    this.waitingLogged.delete(signalId);
    await this.prisma.signal.update({
      where: { id: signalId },
      data: { status: 'CANCELLED' },
    });
  }

  private async createTradeFromSignal(signal: any, config: any, budget: number) {
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