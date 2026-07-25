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
    this.logger.log(
      `Trade #${trade.id} ${trade.symbol}: позиция закрыта на бирже, фиксирую результат`,
    );

    let realizedPnl: number | null = null;

    if (trade.positionId) {
      const now = Date.now();
      const start = now - 7 * 24 * 60 * 60 * 1000;
      const histResp = await this.bingx.getPositionHistory(
        trade.symbol,
        start,
        now,
        trade.positionId,
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

    this.logger.log(
      `Trade #${trade.id} ${trade.symbol}: ЗАКРЫТА, realizedPnl=${realizedPnl}`,
    );
    await this.updateBalanceAfterClose(realizedPnl);

    // Обновляем сигнал после бюджета — если упадёт (уже CANCELLED/COMPLETED), бюджет уже обновлён
    try {
      await this.prisma.signal.update({
        where: { id: trade.signalId },
        data: { status: 'COMPLETED' },
      });
    } catch (e) {
      this.logger.warn(
        `Trade #${trade.id}: не удалось обновить статус сигнала: ${e}`,
      );
    }
  }

  private async updateBalanceAfterClose(realizedPnl: number | null) {
    if (realizedPnl === null) return; // нет данных о результате — баланс не трогаем

    const botConfig = await this.prisma.botConfig.findUnique({
      where: { id: 1 },
    });
    if (!botConfig) return;

    if (botConfig.autoUpdateBalance) {
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
    }

    await this.checkDrawdownAndGrowth();
  }

  // Проверка просадки/роста от стартового баланса. Работает и без autoUpdateBalance:
  // тогда текущий баланс считается как startBalance + сумма realizedPnl закрытых
  // сделок с момента lastStartAt (указывается руками вместе со startBalance).
  private async checkDrawdownAndGrowth() {
    const botConfig = await this.prisma.botConfig.findUnique({
      where: { id: 1 },
    });
    if (!botConfig || !botConfig.isActive || !botConfig.startBalance) return;

    const start = Number(botConfig.startBalance);
    let currentBalance: number;

    if (botConfig.autoUpdateBalance) {
      currentBalance = Number(botConfig.budget);
    } else {
      if (!botConfig.lastStartAt) return; // нет точки отсчёта — не считаем
      const { _sum } = await this.prisma.trade.aggregate({
        where: { status: 'CLOSED', updatedAt: { gte: botConfig.lastStartAt } },
        _sum: { realizedPnl: true },
      });
      currentBalance = start + Number(_sum.realizedPnl ?? 0);
    }

    const maxDd = Number(botConfig.maxDrawdownPercent ?? 0);
    if (maxDd > 0) {
      const limit = start * (1 - maxDd / 100);
      if (currentBalance < limit) {
        await this.stopBot(
          `🛑 ПРОСАДКА! Баланс ${currentBalance.toFixed(2)} < лимит ${limit.toFixed(2)} ` +
            `(старт ${start.toFixed(2)}, макс. просадка ${maxDd}%)`,
        );
        return;
      }
    }

    const maxGrowth = Number(botConfig.maxGrowthPercent ?? 0);
    if (maxGrowth > 0) {
      const limit = start * (1 + maxGrowth / 100);
      if (currentBalance > limit) {
        await this.stopBot(
          `🛑 РОСТ! Баланс ${currentBalance.toFixed(2)} > лимит ${limit.toFixed(2)} ` +
            `(старт ${start.toFixed(2)}, макс. рост ${maxGrowth}%)`,
        );
      }
    }
  }

  private async stopBot(reason: string) {
    await this.prisma.botConfig.update({
      where: { id: 1 },
      data: { isActive: false },
    });
    this.logger.error(`${reason} — БОТ ОСТАНОВЛЕН (isActive=false)`);
  }

  // Отмена CLOSE-ордера с проверкой результата на бирже.
  // Возвращает true только если биржа подтвердила CANCELLED.
  private async cancelCloseOrder(trade: any, order: any): Promise<boolean> {
    if (!order.bingxOrderId) {
      await this.prisma.order.update({
        where: { id: order.id },
        data: { status: 'CANCELLED' },
      });
      return true;
    }

    const cancelResult = await this.bingx.cancelOrder(
      trade.symbol,
      order.bingxOrderId,
    );
    this.logger.log(
      `Trade #${trade.id} ${trade.symbol}: отмена CLOSE ${order.bingxOrderId} → ` +
        `code=${cancelResult?.code}, msg=${cancelResult?.msg ?? '—'}`,
    );

    const resp = await this.bingx.queryOrder(trade.symbol, order.bingxOrderId);
    const exchangeStatus = resp.data?.order?.status;

    if (exchangeStatus === 'CANCELLED') {
      await this.prisma.order.update({
        where: { id: order.id },
        data: { status: 'CANCELLED' },
      });
      return true;
    }

    if (exchangeStatus === 'FILLED') {
      await this.prisma.order.update({
        where: { id: order.id },
        data: { status: 'FILLED' },
      });
      this.logger.log(
        `Trade #${trade.id}: CLOSE ордер исполнился — закрытие поймает следующий тик`,
      );
      return false;
    }

    this.logger.error(
      `Trade #${trade.id}: ордер ${order.bingxOrderId} не подтверждён как CANCELLED ` +
        `(status=${exchangeStatus ?? 'неизвестен'}) — пропускаю`,
    );
    return false;
  }

  private async manageBreakevenExit(trade: any, position: any) {
    const existing = trade.orders.find(
      (o: any) =>
        o.purpose === 'CLOSE' && ['NEW', 'PENDING'].includes(o.status),
    );

    const contractInfo = await this.bingx.getContractInfo(trade.symbol);
    const pricePrecision = contractInfo.data[0].pricePrecision;
    const be = Number(trade.breakevenPrice);
    const factor = Math.pow(10, pricePrecision);
    // LONG продаём — округляем ВВЕРХ (не ниже безубытка); SHORT откупаем — ВНИЗ
    const closePrice =
      trade.side === 'LONG'
        ? Math.ceil(be * factor) / factor
        : Math.floor(be * factor) / factor;

    if (existing) {
      // Проверяем: ордер уже на нужной BREAKEVEN-цене (допуск = 1 тик)?
      if (Math.abs(Number(existing.price) - closePrice) < 1 / factor) {
        return; // правильный ордер уже стоит, ждём исполнения
      }
      // Ордер на другой цене (например остался от PROFIT-режима) — отменяем с проверкой
      this.logger.warn(
        `Trade #${trade.id} ${trade.symbol}: CLOSE ордер на цене ${Number(existing.price)} ` +
          `не совпадает с BREAKEVEN ${closePrice} — отменяю`,
      );
      const cancelled = await this.cancelCloseOrder(trade, existing);
      if (!cancelled) return; // биржа не подтвердила — не ставим новый
    }

    const quantity = Math.abs(Number(position.positionAmt));
    if (quantity <= 0) return;

    const closeSide = trade.side === 'LONG' ? 'SELL' : 'BUY';

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
      trade.symbol,
      closeSide,
      trade.side,
      closePrice,
      quantity,
    );

    if (result.code === 0 && result.data?.order) {
      const bingxOrderId = String(
        result.data.order.orderID || result.data.order.orderId,
      );
      await this.prisma.order.update({
        where: { id: orderRecord.id },
        data: { bingxOrderId, status: 'PENDING' },
      });
      this.logger.log(
        `Trade #${trade.id} ${trade.symbol}: BREAKEVEN-лимит на ${closePrice}, qty=${quantity} (не переставляю)`,
      );
    } else {
      await this.prisma.order.update({
        where: { id: orderRecord.id },
        data: { status: 'FAILED' },
      });
      this.logger.error(
        `Trade #${trade.id}: не выставить BREAKEVEN-лимит: ${JSON.stringify(result)}`,
      );
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
      this.logger.log(
        `Trade #${trade.id} ${trade.symbol}: позиция закрылась на бирже (closeMode=${trade.closeMode})`,
      );
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
        this.logger.log(
          `#${trade.id} ${trade.symbol}: BREAKEVEN-режим, цена выхода=${Number(trade.breakevenPrice).toFixed(6)}`,
        );
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
      const slLevel =
        trade.side === 'LONG' ? eff * (1 - slPercent) : eff * (1 + slPercent);

      const inLossZone =
        trade.side === 'LONG'
          ? currentPrice <= slLevel
          : currentPrice >= slLevel;

      if (inLossZone) {
        this.logger.warn(
          `Trade #${trade.id} ${trade.symbol}: цена ${currentPrice} упала к SL ${slLevel.toFixed(6)}, ` +
            `переключаюсь PROFIT→LOSS`,
        );

        // Снимаем плюсовой лимит на TP
        const profitOrder = trade.orders.find(
          (o: any) =>
            o.purpose === 'CLOSE' && ['NEW', 'PENDING'].includes(o.status),
        );
        if (profitOrder) {
          const cancelled = await this.cancelCloseOrder(trade, profitOrder);
          if (!cancelled) return; // не подтверждена отмена — не переходим в LOSS пока
          // Обновим локальный список ордеров — снятый больше не активен
          profitOrder.status = 'CANCELLED';
        }

        // Переключаемся в LOSS и начинаем выход
        await this.prisma.trade.update({
          where: { id: trade.id },
          data: { closeMode: 'LOSS' },
        });
        trade.closeMode = 'LOSS';

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
    const factor = Math.pow(10, pricePrecision);
    // Гоним ценой на 1 тик хуже текущей, чтобы гарантированно исполниться:
    // LONG продаём — на тик ниже; SHORT откупаем — на тик выше
    const rawPrice =
      trade.side === 'LONG'
        ? currentPrice - 1 / factor
        : currentPrice + 1 / factor;
    const closePrice = roundToPrecision(rawPrice, pricePrecision);

    // Активный CLOSE-ордер?
    const existingClose = trade.orders.find(
      (o: any) =>
        o.purpose === 'CLOSE' && ['NEW', 'PENDING'].includes(o.status),
    );

    // Если уже есть ордер на этой же цене — ничего не делаем (не переставляем впустую)
    if (existingClose && Number(existingClose.price) === closePrice) {
      return;
    }

    // Отменяем старый с проверкой (переставляем по текущей цене)
    if (existingClose) {
      const cancelled = await this.cancelCloseOrder(trade, existingClose);
      if (!cancelled) return; // биржа не подтвердила — не ставим дублирующий ордер
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
      trade.symbol,
      closeSide,
      trade.side,
      closePrice,
      quantity,
    );

    if (result.code === 0 && result.data?.order) {
      const bingxOrderId = String(
        result.data.order.orderID || result.data.order.orderId,
      );
      await this.prisma.order.update({
        where: { id: orderRecord.id },
        data: { bingxOrderId, status: 'PENDING' },
      });
      this.logger.log(
        `Trade #${trade.id} ${trade.symbol}: выход в минус, лимит по ${closePrice}, qty=${quantity}`,
      );
    } else {
      await this.prisma.order.update({
        where: { id: orderRecord.id },
        data: { status: 'FAILED' },
      });
      this.logger.error(
        `Trade #${trade.id}: не выставить лимит выхода: ${JSON.stringify(result)}`,
      );
    }
  }

  private async placeProfitLimit(trade: any, position: any, _config: any) {
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
      trade.symbol,
      closeSide,
      trade.side,
      closePrice,
      quantity,
    );

    if (result.code === 0 && result.data?.order) {
      const bingxOrderId = String(
        result.data.order.orderID || result.data.order.orderId,
      );
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
        where: { id: orderRecord.id },
        data: { status: 'FAILED' },
      });
      this.logger.error(
        `Trade #${trade.id}: не выставить лимит закрытия: ${JSON.stringify(result)}`,
      );
    }
  }

  private async manageClose(trade: any, position: any, _allOpenOrders: any[]) {
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
    const slLevel =
      trade.side === 'LONG' ? eff * (1 - slPercent) : eff * (1 + slPercent);

    // Определяем зону
    const inProfitZone =
      trade.side === 'LONG'
        ? currentPrice > eff * (1 + threshold)
        : currentPrice < eff * (1 - threshold);

    const inLossZone =
      trade.side === 'LONG' ? currentPrice <= slLevel : currentPrice >= slLevel;

    const existingClose = trade.orders.find(
      (o: any) =>
        o.purpose === 'CLOSE' && ['NEW', 'PENDING'].includes(o.status),
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
    if (existingClose) {
      const cancelled = await this.cancelCloseOrder(trade, existingClose);
      if (cancelled) {
        this.logger.log(
          `Trade #${trade.id} ${trade.symbol}: цена в мёртвой зоне, снял лимит закрытия`,
        );
      }
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

    const hasTp = await this.hasSafetyOrder(
      trade,
      'SAFETY_TP',
      'TAKE_PROFIT_MARKET',
      allOpenOrders,
      closeSide,
    );
    if (!hasTp) {
      await this.placeSafetyOrder(
        trade,
        'SAFETY_TP',
        'TAKE_PROFIT_MARKET',
        closeSide,
        quantity,
      );
    }

    const hasSl = await this.hasSafetyOrder(
      trade,
      'SAFETY_SL',
      'STOP_MARKET',
      allOpenOrders,
      closeSide,
    );
    if (!hasSl) {
      await this.placeSafetyOrder(
        trade,
        'SAFETY_SL',
        'STOP_MARKET',
        closeSide,
        quantity,
      );
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
        o.purpose === purpose && ['NEW', 'PENDING'].includes(o.status),
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
      const bingxOrderId = String(
        result.data.order.orderID || result.data.order.orderId,
      );
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
