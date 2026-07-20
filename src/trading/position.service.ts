import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BingxService } from '../bingx/bingx.service';
import { roundToPrecision } from './trading.utils';

@Injectable()
export class PositionService {
  private readonly logger = new Logger(PositionService.name);
  private closeRetries = new Map<number, number>();
  private breakevenLogged = new Set<number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly bingx: BingxService,
  ) {}

  





  async onPositionClosed(trade: any) {
    this.logger.log(`Trade #${trade.id} ${trade.symbol}: позиция закрыта на бирже, фиксирую результат`);

    let realizedPnl: number | null = null;

    if (trade.positionId) {
      const now = Date.now();
      const start = now - 7 * 24 * 60 * 60 * 1000;
      const histResp = await this.bingx.getPositionHistory(
        trade.symbol, start, now, trade.positionId,
      );
      const records = histResp.data?.positionHistory || [];
      const record = records.find(
        (r: any) => String(r.positionId) === String(trade.positionId),
      );

      if (record) {
        realizedPnl = Number(record.netProfit);
        this.logger.log(
          `Trade #${trade.id} ${trade.symbol}: netProfit=${record.netProfit}, ` +
          `realised=${record.realisedProfit}, commission=${record.positionCommission}`,
        );
      } else {
        // История ещё не подтянулась — даём бирже время (ретрай на следующих тиках)
        const attempts = (this.closeRetries.get(trade.id) || 0) + 1;
        const MAX_ATTEMPTS = 10; // ~10 тиков (около минуты при тике 5с)

        if (attempts < MAX_ATTEMPTS) {
          this.closeRetries.set(trade.id, attempts);
          this.logger.warn(
            `Trade #${trade.id}: позиция ${trade.positionId} ещё не в истории ` +
            `(попытка ${attempts}/${MAX_ATTEMPTS}) — жду, не фиксирую`,
          );
          return; // НЕ закрываем сделку, попробуем снова на след. тике
        }

        // Исчерпали попытки — фиксируем без PnL, чтобы сделка не висела вечно
        this.logger.error(
          `Trade #${trade.id}: позиция ${trade.positionId} так и не найдена в истории ` +
          `после ${MAX_ATTEMPTS} попыток — закрываю с realizedPnl=null`,
        );
      }
    }

    // Сюда доходим когда: PnL получен ИЛИ исчерпаны попытки
    this.closeRetries.delete(trade.id); // очищаем счётчик

    await this.prisma.order.updateMany({
      where: { tradeId: trade.id, status: { in: ['NEW', 'PENDING'] } },
      data: { status: 'CANCELLED' },
    });

    await this.prisma.trade.update({
      where: { id: trade.id },
      data: { status: 'CLOSED', realizedPnl },
    });

    await this.prisma.signal.update({
      where: { id: trade.signalId },
      data: { status: 'COMPLETED' },
    });

    this.logger.log(`Trade #${trade.id} ${trade.symbol}: ЗАКРЫТА, realizedPnl=${realizedPnl}`);
    await this.updateBalanceAfterClose(realizedPnl);
  }


  private async updateBalanceAfterClose(realizedPnl: number | null) {
    if (realizedPnl === null) return; // нет данных о результате — баланс не трогаем

    const botConfig = await this.prisma.botConfig.findUnique({ where: { id: 1 } });
    if (!botConfig || !botConfig.autoUpdateBalance) return; // фича выключена

    // Консервативное округление: прибыль вниз, убыток больше (floor работает для обоих знаков)
    const rounded = Math.floor(realizedPnl * 100) / 100;
    const oldBudget = Number(botConfig.budget);
    const newBudget = oldBudget + rounded;

    await this.prisma.botConfig.update({
      where: { id: 1 },
      data: { budget: newBudget },
    });

    this.logger.log(
      `💰 Баланс обновлён: ${oldBudget.toFixed(2)} → ${newBudget.toFixed(2)} (PnL ${rounded.toFixed(2)})`,
    );

    // === Проверка просадки от стартового баланса ===
    if (botConfig.startBalance && botConfig.maxDrawdownPercent) {
      const start = Number(botConfig.startBalance);
      const maxDd = Number(botConfig.maxDrawdownPercent);
      const limit = start * (1 - maxDd / 100);

      if (newBudget < limit) {
        await this.prisma.botConfig.update({
          where: { id: 1 },
          data: { isActive: false },
        });
        this.logger.error(
          `🛑 ПРОСАДКА! Баланс ${newBudget.toFixed(2)} < лимит ${limit.toFixed(2)} ` +
          `(старт ${start.toFixed(2)}, макс. просадка ${maxDd}%) — БОТ ОСТАНОВЛЕН (isActive=false)`,
        );
      }
    }
  }




private async manageBreakevenExit(trade: any, position: any) {
    const existing = trade.orders.find(
      (o: any) => o.purpose === 'CLOSE' && ['NEW', 'PENDING'].includes(o.status),
    );
    if (existing) return; // лимит уже стоит, ждём исполнения

    const quantity = Math.abs(Number(position.positionAmt));
    if (quantity <= 0) return;

    const closeSide = trade.side === 'LONG' ? 'SELL' : 'BUY';

    // Цена безубыточности с округлением в безопасную сторону
    const contractInfo = await this.bingx.getContractInfo(trade.symbol);
    const pricePrecision = contractInfo.data[0].pricePrecision;
    const be = Number(trade.breakevenPrice);
    // LONG продаём — округляем ВВЕРХ (не ниже безубытка); SHORT откупаем — ВНИЗ
    const factor = Math.pow(10, pricePrecision);
    const closePrice =
      trade.side === 'LONG'
        ? Math.ceil(be * factor) / factor
        : Math.floor(be * factor) / factor;

    const orderRecord = await this.prisma.order.create({
      data: {
        tradeId: trade.id,
        bingxOrderId: '',
        purpose: 'CLOSE',
        type: 'LIMIT',
        side: closeSide as any,
        positionSide: trade.side,
        price: closePrice,
        quantity,
        status: 'NEW',
      },
    });

    const result = await this.bingx.placeOrder(
      trade.symbol, closeSide as 'BUY' | 'SELL', trade.side, closePrice, quantity,
    );

    if (result.code === 0 && result.data?.order) {
      const bingxOrderId = String(result.data.order.orderID || result.data.order.orderId);
      await this.prisma.order.update({
        where: { id: orderRecord.id },
        data: { bingxOrderId, status: 'PENDING' },
      });
      this.logger.log(
        `Trade #${trade.id} ${trade.symbol}: BREAKEVEN-лимит на ${closePrice}, qty=${quantity} (не переставляю)`,
      );
    } else {
      await this.prisma.order.update({
        where: { id: orderRecord.id }, data: { status: 'FAILED' },
      });
      this.logger.error(`Trade #${trade.id}: не выставить BREAKEVEN-лимит: ${JSON.stringify(result)}`);
    }
  }




async manageClosing(trade: any, allPositions: any[]) {
    const position = allPositions.find(
      (p: any) =>
        p.symbol === trade.symbol &&
        p.positionSide === trade.side &&
        Number(p.positionAmt) !== 0,
    );

    if (!position) {
      this.breakevenLogged.delete(trade.id);
      await this.onPositionClosed(trade);
      return;
    }

    // Если вышли из BREAKEVEN-режима — сбрасываем флаг чтобы при следующем входе снова залогировать
    if (trade.closeMode !== 'BREAKEVEN') {
      this.breakevenLogged.delete(trade.id);
    }

    // Режим BREAKEVEN — один лимит на цену безубыточности, не переставляем
    if (trade.closeMode === 'BREAKEVEN') {
      if (!this.breakevenLogged.has(trade.id)) {
        this.logger.log(`#${trade.id} ${trade.symbol}: BREAKEVEN-режим, цена выхода=${Number(trade.breakevenPrice).toFixed(6)}`);
        this.breakevenLogged.add(trade.id);
      }
      await this.manageBreakevenExit(trade, position);
      return;
    }

    // Режим LOSS — не передумываем, гоним выход за ценой
    if (trade.closeMode === 'LOSS') {
      await this.manageLossExit(trade, position);
      return;
    }

    // Режим PROFIT — проверяем, не упала ли цена к рабочему SL (переключение PROFIT→LOSS)
    if (trade.closeMode === 'PROFIT') {
      const config = await this.prisma.symbolConfig.findUnique({
        where: { symbol: trade.symbol },
      });
      if (!config) return;

      const ticker = await this.bingx.getPrice(trade.symbol);
      const currentPrice = Number(ticker.data.price);
      const eff = Number(trade.effectiveEntryPrice);
      const slPercent = Number(config.stopLossPercent) / 100;
      const slLevel = trade.side === 'LONG' ? eff * (1 - slPercent) : eff * (1 + slPercent);

      const inLossZone =
        trade.side === 'LONG' ? currentPrice <= slLevel : currentPrice >= slLevel;

      if (inLossZone) {
        this.logger.warn(
          `Trade #${trade.id} ${trade.symbol}: цена ${currentPrice} упала к SL ${slLevel.toFixed(6)}, ` +
          `переключаюсь PROFIT→LOSS`,
        );

        // Снимаем плюсовой лимит на TP
        const profitOrder = trade.orders.find(
          (o: any) => o.purpose === 'CLOSE' && ['NEW', 'PENDING'].includes(o.status),
        );
        if (profitOrder && profitOrder.bingxOrderId) {
          await this.bingx.cancelOrder(trade.symbol, profitOrder.bingxOrderId);
          await this.prisma.order.update({
            where: { id: profitOrder.id },
            data: { status: 'CANCELLED' },
          });
        }

        // Переключаемся в LOSS и начинаем выход
        await this.prisma.trade.update({
          where: { id: trade.id },
          data: { closeMode: 'LOSS' },
        });
        trade.closeMode = 'LOSS';
        // Обновим локальный список ордеров — снятый больше не активен
        if (profitOrder) profitOrder.status = 'CANCELLED';

        await this.manageLossExit(trade, position);
        return;
      }

      // Цена не упала к SL — плюсовой лимит на TP висит, ждём исполнения
    }
  }




  private async manageLossExit(trade: any, position: any) {
    const quantity = Math.abs(Number(position.positionAmt));
    if (quantity <= 0) return; // позиции нет — закрытие поймает manageClosing

    const closeSide = trade.side === 'LONG' ? 'SELL' : 'BUY';

    const ticker = await this.bingx.getPrice(trade.symbol);
    const currentPrice = Number(ticker.data.price);

    const contractInfo = await this.bingx.getContractInfo(trade.symbol);
    const pricePrecision = contractInfo.data[0].pricePrecision;
    const closePrice = roundToPrecision(currentPrice, pricePrecision);

    // Активный CLOSE-ордер?
    const existingClose = trade.orders.find(
      (o: any) => o.purpose === 'CLOSE' && ['NEW', 'PENDING'].includes(o.status),
    );

  // Если уже есть ордер на этой же цене — ничего не делаем (не переставляем впустую)
    if (existingClose && Number(existingClose.price) === closePrice) {
      return;
    }

    // Отменяем старый (переставляем по текущей цене)
    if (existingClose && existingClose.bingxOrderId) {
      await this.bingx.cancelOrder(trade.symbol, existingClose.bingxOrderId);
      await this.prisma.order.update({
        where: { id: existingClose.id },
        data: { status: 'CANCELLED' },
      });
    }

    // Выставляем новый по текущей цене на остаток
    const orderRecord = await this.prisma.order.create({
      data: {
        tradeId: trade.id,
        bingxOrderId: '',
        purpose: 'CLOSE',
        type: 'LIMIT',
        side: closeSide as any,
        positionSide: trade.side,
        price: closePrice,
        quantity,
        status: 'NEW',
      },
    });

    const result = await this.bingx.placeOrder(
      trade.symbol, closeSide as 'BUY' | 'SELL', trade.side, closePrice, quantity,
    );

    if (result.code === 0 && result.data?.order) {
      const bingxOrderId = String(result.data.order.orderID || result.data.order.orderId);
      await this.prisma.order.update({
        where: { id: orderRecord.id },
        data: { bingxOrderId, status: 'PENDING' },
      });
      this.logger.log(
        `Trade #${trade.id} ${trade.symbol}: выход в минус, лимит по ${closePrice}, qty=${quantity}`,
      );
    } else {
      await this.prisma.order.update({
        where: { id: orderRecord.id }, data: { status: 'FAILED' },
      });
      this.logger.error(`Trade #${trade.id}: не выставить лимит выхода: ${JSON.stringify(result)}`);
    }
  }

private async placeProfitLimit(trade: any, position: any, config: any) {
    const quantity = Math.abs(Number(position.positionAmt));
    const closeSide = trade.side === 'LONG' ? 'SELL' : 'BUY';
    const closePrice = Number(trade.takeProfitPrice);

    const orderRecord = await this.prisma.order.create({
      data: {
        tradeId: trade.id,
        bingxOrderId: '',
        purpose: 'CLOSE',
        type: 'LIMIT',
        side: closeSide as any,
        positionSide: trade.side,
        price: closePrice,
        quantity,
        status: 'NEW',
      },
    });

    const result = await this.bingx.placeOrder(
      trade.symbol, closeSide as 'BUY' | 'SELL', trade.side, closePrice, quantity,
    );

    if (result.code === 0 && result.data?.order) {
      const bingxOrderId = String(result.data.order.orderID || result.data.order.orderId);
      await this.prisma.order.update({
        where: { id: orderRecord.id },
        data: { bingxOrderId, status: 'PENDING' },
      });
      await this.prisma.trade.update({
        where: { id: trade.id },
        data: { status: 'CLOSING', closeMode: 'PROFIT' },
      });
      this.logger.log(
        `Trade #${trade.id} ${trade.symbol}: лимит закрытия в плюс на ${closePrice}, qty=${quantity}, статус CLOSING`,
      );
    } else {
      await this.prisma.order.update({
        where: { id: orderRecord.id }, data: { status: 'FAILED' },
      });
      this.logger.error(`Trade #${trade.id}: не выставить лимит закрытия: ${JSON.stringify(result)}`);
    }
  }






private async manageClose(trade: any, position: any, allOpenOrders: any[]) {
    const config = await this.prisma.symbolConfig.findUnique({
      where: { symbol: trade.symbol },
    });
    if (!config) return;

    // Если уже в режиме выхода в минус — не передумываем, гоним выход
    if (trade.closeMode === 'LOSS') {
      await this.manageLossExit(trade, position);
      return;
    }

    const ticker = await this.bingx.getPrice(trade.symbol);
    const currentPrice = Number(ticker.data.price);
    const eff = Number(trade.effectiveEntryPrice);
    const threshold = Number(config.repriceThresholdPercent) / 100;
    const slPercent = Number(config.stopLossPercent) / 100;

    // Уровень рабочего SL
    const slLevel = trade.side === 'LONG' ? eff * (1 - slPercent) : eff * (1 + slPercent);

    // Определяем зону
    const inProfitZone =
      trade.side === 'LONG'
        ? currentPrice > eff * (1 + threshold)
        : currentPrice < eff * (1 - threshold);

    const inLossZone =
      trade.side === 'LONG'
        ? currentPrice <= slLevel
        : currentPrice >= slLevel;

    const existingClose = trade.orders.find(
      (o: any) => o.purpose === 'CLOSE' && ['NEW', 'PENDING'].includes(o.status),
    );

    if (inLossZone) {
      // Цена коснулась рабочего SL → включаем выход в минус
      this.logger.warn(
        `Trade #${trade.id} ${trade.symbol}: цена ${currentPrice} достигла SL ${slLevel.toFixed(6)}, выход в минус`,
      );
      await this.prisma.trade.update({
        where: { id: trade.id },
        data: { closeMode: 'LOSS', status: 'CLOSING' },
      });
      // обновим локальный объект, чтобы manageLossExit увидел актуальное
      trade.closeMode = 'LOSS';
      await this.manageLossExit(trade, position);
      return;
    }

    if (inProfitZone) {
      // Плюсовая зона → лимит на TP (если ещё нет)
      if (existingClose) return;
      await this.placeProfitLimit(trade, position, config);
      return;
    }

    // Мёртвая зона → снять рабочий CLOSE-ордер, если висит
    if (existingClose && existingClose.bingxOrderId) {
      await this.bingx.cancelOrder(trade.symbol, existingClose.bingxOrderId);
      await this.prisma.order.update({
        where: { id: existingClose.id },
        data: { status: 'CANCELLED' },
      });
      this.logger.log(`Trade #${trade.id} ${trade.symbol}: цена в мёртвой зоне, снял лимит закрытия`);
    }
  }




  async manageOpen(trade: any, allOpenOrders: any[], allPositions: any[]) {
    // ===== ПЕРВОЕ: жива ли позиция? =====
    const position = allPositions.find(
      (p: any) =>
        p.symbol === trade.symbol &&
        p.positionSide === trade.side &&
        Number(p.positionAmt) !== 0,
    );

    if (!position) {
      // Позиция закрылась (страховочным ордером или иначе) — фиксируем результат
      await this.onPositionClosed(trade);
      return;
    }

    // ===== Позиция жива: выставляем/проверяем страховочные TP/SL =====
    const quantity = Math.abs(Number(position.positionAmt));
    const closeSide = trade.side === 'LONG' ? 'SELL' : 'BUY';

    const hasTp = await this.hasSafetyOrder(trade, 'SAFETY_TP', 'TAKE_PROFIT_MARKET', allOpenOrders, closeSide);
    if (!hasTp) {
      await this.placeSafetyOrder(trade, 'SAFETY_TP', 'TAKE_PROFIT_MARKET', closeSide, quantity);
    }

    const hasSl = await this.hasSafetyOrder(trade, 'SAFETY_SL', 'STOP_MARKET', allOpenOrders, closeSide);
    if (!hasSl) {
      await this.placeSafetyOrder(trade, 'SAFETY_SL', 'STOP_MARKET', closeSide, quantity);
    }
    
     await this.manageClose(trade, position, allOpenOrders);
  }



  private async hasSafetyOrder(
    trade: any,
    purpose: 'SAFETY_TP' | 'SAFETY_SL',
    bingxType: 'TAKE_PROFIT_MARKET' | 'STOP_MARKET',
    allOpenOrders: any[],
    closeSide: string,
  ): Promise<boolean> {
    // Проверка в БД: есть активная запись этого назначения?
    const inDb = trade.orders.find(
      (o: any) =>
        o.purpose === purpose &&
        ['NEW', 'PENDING'].includes(o.status),
    );

    // Проверка на бирже: есть условный ордер нужного типа по символу/стороне?
    const onExchange = allOpenOrders.find(
      (o: any) =>
        o.symbol === trade.symbol &&
        o.type === bingxType &&
        o.positionSide === trade.side &&
        o.side === closeSide,
    );

    return Boolean(inDb) || Boolean(onExchange);
  }

  private async placeSafetyOrder(
    trade: any,
    purpose: 'SAFETY_TP' | 'SAFETY_SL',
    bingxType: 'TAKE_PROFIT_MARKET' | 'STOP_MARKET',
    closeSide: string,
    quantity: number,
  ) {
    const config = await this.prisma.symbolConfig.findUnique({
      where: { symbol: trade.symbol },
    });
    if (!config) return;

    const contractInfo = await this.bingx.getContractInfo(trade.symbol);
    const pricePrecision = contractInfo.data[0].pricePrecision;

    const eff = Number(trade.effectiveEntryPrice);
    const tpP = Number(config.safetyTpPercent) / 100;
    const slP = Number(config.safetySlPercent) / 100;

    // Цена триггера в зависимости от назначения и стороны сделки
    let rawStop: number;
    if (purpose === 'SAFETY_TP') {
      rawStop = trade.side === 'LONG' ? eff * (1 + tpP) : eff * (1 - tpP);
    } else {
      rawStop = trade.side === 'LONG' ? eff * (1 - slP) : eff * (1 + slP);
    }
    const stopPrice = roundToPrecision(rawStop, pricePrecision);

    // 1) Запись намерения
    const orderRecord = await this.prisma.order.create({
      data: {
        tradeId: trade.id,
        bingxOrderId: '',
        purpose,
        type: bingxType,
        side: closeSide as any,
        positionSide: trade.side,
        price: stopPrice,
        quantity,
        status: 'NEW',
      },
    });

    // 2) Выставление на бирже
    const result = await this.bingx.placeStopOrder(
      trade.symbol,
      closeSide as 'BUY' | 'SELL',
      trade.side,
      bingxType,
      stopPrice,
      quantity,
    );

    // 3) Фиксация
    if (result.code === 0 && result.data?.order) {
      const bingxOrderId = String(result.data.order.orderID || result.data.order.orderId);
      await this.prisma.order.update({
        where: { id: orderRecord.id },
        data: { bingxOrderId, status: 'NEW' },
      });
      this.logger.log(
        `Trade #${trade.id} ${trade.symbol}: ${purpose} выставлен, ` +
        `триггер=${stopPrice}, qty=${quantity}, bingxId=${bingxOrderId}`,
      );
    } else {
      await this.prisma.order.update({
        where: { id: orderRecord.id },
        data: { status: 'FAILED' },
      });
      this.logger.error(
        `Trade #${trade.id}: не удалось выставить ${purpose}: ${JSON.stringify(result)}`,
      );
    }
  }

}