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
    // Считаем занятый бюджет по активным сделкам
    const activeTrades = await this.prisma.trade.findMany({
      where: { status: { in: ['ENTERING', 'OPEN', 'CLOSING'] } },
      include: { orders: true },
    });

    if (newSignals.length === 0) {
      const orphanBreakeven = activeTrades.find((t) => t.closeMode === 'BREAKEVEN');
      if (orphanBreakeven) {
        await this.releaseBreakeven(orphanBreakeven);
      }
      return;
    }

    const budget = Number(botConfig.budget);

    
    const usedBudget = activeTrades.reduce(
      (sum, t) => sum + budget * (Number(t.budgetPercent) / 100),
      0,
    );
    const freeBudget = budget - usedBudget;

    for (const signal of newSignals) {
      await this.handleSignal(signal, botConfig, budget, freeBudget, activeTrades, allPositions);
    }
  }




// Пытается вывести одну из позиций в безубыток ради ждущего сигнала (только BALANCED).
  // Один BREAKEVEN на весь бот. Каждый тик пересматривает лучшего кандидата.
  private async tryBreakevenExit(
    signal: any,
    activeTrades: any[],
    allPositions: any[],
  ) {
    // Текущая BREAKEVEN-сделка (если есть)
    const current = activeTrades.find((t) => t.closeMode === 'BREAKEVEN');

    // Кандидаты: чужой символ, OPEN или CLOSING, есть breakevenPrice, есть живая позиция
    const candidates = activeTrades.filter((t) => {
      if (t.symbol === signal.symbol) return false;
      if (t.status !== 'OPEN' && t.status !== 'CLOSING') return false;
      if (t.breakevenPrice == null) return false;
      // LOSS уже закрывается принудительно — не трогаем
      if (t.status === 'CLOSING' && t.closeMode === 'LOSS') return false;
      const pos = allPositions.find(
        (p: any) =>
          p.symbol === t.symbol &&
          p.positionSide === t.side &&
          Number(p.positionAmt) !== 0,
      );
      return Boolean(pos);
    });

    if (candidates.length === 0) {
      // Некого выводить — если был BREAKEVEN, отпускаем
      if (current) await this.releaseBreakeven(current);
      return;
    }

    // Считаем дистанцию до breakeven и делим по направлению
    const oppositeSide = signal.side === 'LONG' ? 'SHORT' : 'LONG';
    const scored = candidates.map((t) => {
      const pos = allPositions.find(
        (p: any) => p.symbol === t.symbol && p.positionSide === t.side && Number(p.positionAmt) !== 0,
      );
      const currentPrice = Number(pos.markPrice);
      const be = Number(t.breakevenPrice);
      const distance = t.side === 'LONG' ? (currentPrice - be) / be : (be - currentPrice) / be;
      return { trade: t, distance };
    });

    // Только противоположные сигналу — попутные не трогаем
    const group = scored.filter((x) => x.trade.side === oppositeSide);

    if (group.length === 0) {
      if (current) await this.releaseBreakeven(current);
      return;
    }

    group.sort((a, b) => b.distance - a.distance);
    const best = group[0].trade;

    // Если лучший уже текущий BREAKEVEN — ничего не меняем
    if (current && current.id === best.id) return;

    // Переключаем только если новый кандидат лучше на 0.02% (абсолютный порог)
    if (current && candidates.some((c) => c.id === current.id)) {
      const currentScore = scored.find((s) => s.trade.id === current.id)?.distance ?? -Infinity;
      if (group[0].distance - currentScore < 0.0002) return;
    }

    // Иначе: отпускаем старого (если был) и метим нового
    if (current) await this.releaseBreakeven(current);

    await this.prisma.trade.update({
      where: { id: best.id },
      data: { status: 'CLOSING', closeMode: 'BREAKEVEN' },
    });
    this.logger.log(
      `Сигнал #${signal.id}: вывожу в безубыток #${best.id} ${best.symbol} ${best.side} ` +
      `(breakeven ${Number(best.breakevenPrice).toFixed(6)})`,
    );
  }

  // Отпустить BREAKEVEN-сделку: отменить её лимит СРАЗУ + вернуть в OPEN
  private async releaseBreakeven(trade: any) {
    // Отменяем активный CLOSE-ордер (BREAKEVEN-лимит) на бирже
    const closeOrder = (trade.orders || []).find(
      (o: any) => o.purpose === 'CLOSE' && ['NEW', 'PENDING'].includes(o.status),
    );
    if (closeOrder && closeOrder.bingxOrderId) {
      try {
        await this.bingx.cancelOrder(trade.symbol, closeOrder.bingxOrderId);
      } catch (e) {
        this.logger.warn(`Не удалось отменить BREAKEVEN-лимит #${trade.id}: ${e}`);
      }
      await this.prisma.order.update({
        where: { id: closeOrder.id },
        data: { status: 'CANCELLED' },
      });
    }

    // Возвращаем в OPEN — manageOpen пересчитает зону заново
    await this.prisma.trade.update({
      where: { id: trade.id },
      data: { status: 'OPEN', closeMode: null },
    });
    this.logger.log(`#${trade.id} ${trade.symbol}: отпущен из BREAKEVEN → OPEN`);
  }





  private async handleSignal(signal, botConfig, budget, freeBudget, activeTrades, allPositions) {
    const config = await this.prisma.symbolConfig.findUnique({ where: { symbol: signal.symbol } });

    if (!this.waitingLogged.has(signal.id)) {
      this.logger.log(
        `Обрабатываю сигнал #${signal.id} ${signal.symbol} ${signal.side}. ` +
        `Активных сделок: ${activeTrades.length} [${activeTrades.map(t => `${t.symbol}/${t.side}/${t.status}`).join(', ')}]`,
      );
    }

    if (!config || !config.isEnabled) {
      this.logger.warn(`Нет активной настройки для ${signal.symbol}, сигнал #${signal.id} отклонён`);
      await this.cancelSignal(signal.id);
      return;
    }

    // ШАГ 0
    const sameSideTrade = activeTrades.find(t => t.symbol === signal.symbol && t.side === signal.side);
    if (sameSideTrade) {
      this.logger.warn(`Сигнал #${signal.id}: дубль → отмена`);
      await this.cancelSignal(signal.id);
      return;
    }

    // ШАГ 1
    const oppositeSide = signal.side === 'LONG' ? 'SHORT' : 'LONG';
    const oppositeTrade = activeTrades.find(t => t.symbol === signal.symbol && t.side === oppositeSide);
    if (!this.waitingLogged.has(signal.id) && oppositeTrade) {
      this.logger.log(
        `#${signal.id}: разворот — найдена ${oppositeSide} #${oppositeTrade.id} (${oppositeTrade.status}) по ${signal.symbol}`,
      );
    }
    if (oppositeTrade) {
      await this.handleReversal(signal, oppositeTrade, botConfig, config, allPositions, activeTrades);
      return;
    }

    // ШАГ 2
    const requiredMargin = budget * (Number(config.budgetPercent) / 100);

    if (requiredMargin <= freeBudget) {
      // Хватает — открываем
      await this.createTradeFromSignal(signal, config, budget);
    } else {
      // Не хватает бюджета — по тактике пытаемся освободить (Часть 3)
      await this.handleBudgetShortage(
        signal, botConfig, config, activeTrades, allPositions, requiredMargin, freeBudget,
      );
    }
  }


private async handleReversal(
    signal: any,
    oppositeTrade: any,
    botConfig: any,
    config: any,
    allPositions: any[],
    activeTrades: any,
  ) {
    // Уже идёт принудительное закрытие (LOSS) — ждём завершения
    if (oppositeTrade.status === 'CLOSING' && oppositeTrade.closeMode === 'LOSS') {
      if (!this.waitingLogged.has(signal.id)) {
        this.logger.log(
          `Сигнал #${signal.id} ${signal.symbol}: разворот, ${oppositeTrade.side} #${oppositeTrade.id} уже закрывается (LOSS) — жду`,
        );
        this.waitingLogged.add(signal.id);
      }
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

    // AGGRESSIVE — закрываем противоположную решительно (LOSS, можно в минус)
    if (strategy === 'AGGRESSIVE') {
      this.logger.log(
        `Сигнал #${signal.id} ${signal.symbol}: разворот AGGRESSIVE → закрываю ${oppositeTrade.side} #${oppositeTrade.id}`,
      );
      await this.forceCloseTrade(oppositeTrade);
      await this.checkSignalTimeout(signal, config);
      return;
    }

// BALANCED — выводим ПРОТИВОПОЛОЖНУЮ позицию (по символу сигнала) в безубыток.
    // Ставим breakeven-лимит на неё, ждём до таймаута сигнала. Не исполнилась → сигнал отменится по таймауту.
    if (oppositeTrade.closeMode !== 'BREAKEVEN') {
      await this.prisma.trade.update({
        where: { id: oppositeTrade.id },
        data: { status: 'CLOSING', closeMode: 'BREAKEVEN' },
      });
      this.logger.log(
        `Сигнал #${signal.id} ${signal.symbol}: разворот BALANCED → вывожу ${oppositeTrade.side} #${oppositeTrade.id} в безубыток`,
      );
    }
    this.waitingLogged.add(signal.id);
    await this.checkSignalTimeout(signal, config);    
  }
  


  // private async checkSignalTimeout(signal: any, config: any) {
  //   const deadline = new Date(
  //     new Date(signal.createdAt).getTime() + config.entryTimeoutSec * 1000,
  //   );
  //   if (new Date() > deadline) {
  //     this.logger.warn(`Сигнал #${signal.id} ${signal.symbol}: истёк таймаут ожидания → отмена`);
  //     await this.cancelSignal(signal.id);
  //   }
  // }

  private async checkSignalTimeout(signal: any, config: any) {
    const deadline = new Date(
      new Date(signal.createdAt).getTime() + config.entryTimeoutSec * 1000,
    );
    if (new Date() > deadline) {
      this.logger.warn(`Сигнал #${signal.id} ${signal.symbol}: истёк таймаут ожидания → отмена`);
      // Если по этому символу есть противоположная в BREAKEVEN (ради этого разворота) — отпускаем
      const breakevenTrade = await this.prisma.trade.findFirst({
        where: { symbol: signal.symbol, closeMode: 'BREAKEVEN', status: 'CLOSING' },
        include: { orders: true },
      });
      if (breakevenTrade) {
        await this.releaseBreakeven(breakevenTrade);
      }
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


private async forceCloseTrade(trade: any) {
    await this.prisma.trade.update({
      where: { id: trade.id },
      data: { status: 'CLOSING', closeMode: 'LOSS' },
    });
    this.logger.log(`Trade #${trade.id} ${trade.symbol}: помечена на принудительное закрытие (LOSS-выход)`);
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


// === Часть 3: нехватка бюджета — закрытие чужой позиции по тактике ===
  private async handleBudgetShortage(
    signal: any,
    botConfig: any,
    config: any,
    activeTrades: any[],
    allPositions: any[],
    requiredMargin: number,
    freeBudget: number,
  ) {
    const strategy = botConfig.conflictStrategy;

    // CONSERVATIVE — ничего не закрываем, ждём
    if (strategy === 'CONSERVATIVE') {
      if (!this.waitingLogged.has(signal.id)) {
        this.logger.log(
          `Сигнал #${signal.id} ${signal.symbol}: не хватает бюджета ` +
          `(нужно ${requiredMargin.toFixed(2)}, свободно ${freeBudget.toFixed(2)}), CONSERVATIVE — жду`,
        );
        this.waitingLogged.add(signal.id);
      }
      await this.checkSignalTimeout(signal, config);
      return;
    }

    // Освобождение уже идёт? (чужая сделка в CLOSING с closeMode=LOSS)
    const releasingInProgress = activeTrades.find(
      (t) =>
        t.symbol !== signal.symbol &&
        t.status === 'CLOSING' &&
        t.closeMode === 'LOSS',
    );
    if (releasingInProgress) {
      if (!this.waitingLogged.has(signal.id)) {
        this.logger.log(
          `Сигнал #${signal.id} ${signal.symbol}: освобождение бюджета уже идёт ` +
          `(#${releasingInProgress.id} ${releasingInProgress.symbol}) — жду`,
        );
        this.waitingLogged.add(signal.id);
      }
      await this.checkSignalTimeout(signal, config);
      return;
    }

    // AGGRESSIVE — выбираем жертву и закрываем решительно (LOSS)
    if (strategy === 'AGGRESSIVE') {
      const victim = this.pickBudgetVictim(signal, strategy, activeTrades, allPositions);
      if (!victim) {
        if (!this.waitingLogged.has(signal.id)) {
          this.logger.log(`Сигнал #${signal.id} ${signal.symbol}: нет позиции для закрытия (AGGRESSIVE) — жду`);
          this.waitingLogged.add(signal.id);
        }
        await this.checkSignalTimeout(signal, config);
        return;
      }
      this.logger.log(`Сигнал #${signal.id} ${signal.symbol}: AGGRESSIVE → закрываю #${victim.id} ${victim.symbol} ${victim.side} ради бюджета`);
      await this.forceCloseTrade(victim);
      await this.checkSignalTimeout(signal, config);
      return;
    }

    // BALANCED — всегда через безубыток
    await this.tryBreakevenExit(signal, activeTrades, allPositions);
    if (!this.waitingLogged.has(signal.id)) {
      this.logger.log(`Сигнал #${signal.id} ${signal.symbol}: BALANCED → пробую безубыток ради бюджета`);
      this.waitingLogged.add(signal.id);
    }
    await this.checkSignalTimeout(signal, config);
  }

  // Выбор позиции для закрытия ради бюджета.
  // Только противоположные сигналу — попутные не трогаем.
  // BALANCED — только прибыльные (>=0). AGGRESSIVE — любые.
  private pickBudgetVictim(
    signal: any,
    strategy: string,
    activeTrades: any[],
    allPositions: any[],
  ): any | null {
    const oppositeSide = signal.side === 'LONG' ? 'SHORT' : 'LONG';

    // Кандидаты: чужой символ, статус OPEN или CLOSING+PROFIT (позиция реально держится)
    const candidates = activeTrades.filter(
      (t) =>
        t.symbol !== signal.symbol &&
        (t.status === 'OPEN' || (t.status === 'CLOSING' && t.closeMode === 'PROFIT')),
    );

    // Обогащаем unrealizedProfit из позиций
    const withProfit = candidates.map((t) => {
      const pos = allPositions.find(
        (p: any) =>
          p.symbol === t.symbol &&
          p.positionSide === t.side &&
          Number(p.positionAmt) !== 0,
      );
      const profit = pos ? Number(pos.unrealizedProfit) : 0;
      return { trade: t, profit };
    });

    // Фильтр по тактике: BALANCED только прибыльные, AGGRESSIVE любые
    const pool =
      strategy === 'BALANCED'
        ? withProfit.filter((x) => x.profit >= 0)
        : withProfit;

    if (pool.length === 0) return null;

    // Только противоположные сигналу — попутные не трогаем
    const group = pool.filter((x) => x.trade.side === oppositeSide);
    if (group.length === 0) return null;

    // Внутри группы — с наибольшим профитом
    group.sort((a, b) => b.profit - a.profit);
    return group[0].trade;
  }
}