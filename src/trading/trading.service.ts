import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { BingxService } from '../bingx/bingx.service';

@Injectable()
export class TradingService implements OnModuleInit {
  private readonly logger = new Logger(TradingService.name);
  private isRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly bingx: BingxService,
  ) {}

  async onModuleInit() {
    this.logger.log('TradingService запущен');
    await this.tick();
  }






  @Interval(3000)
  async tick() {
    if (this.isRunning) {
      this.logger.warn('Предыдущий тик ещё работает, пропускаю');
      return;
    }
    this.isRunning = true;
    try {
      await this.processNewSignals();
      await this.manageActiveTrades();      
    } catch (error) {
      this.logger.error('Ошибка в тике', error);
    } finally {
      this.isRunning = false;
    }
  }







  private async processNewSignals() {
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

    // Текущая цена символа
    const ticker = await this.bingx.getPrice(signal.symbol);
    const currentPrice = Number(ticker.data.price);

    // Расчёт целевого размера (Вариант A: бюджет = маржа, плечо умножает позицию)
    const budgetPercent = Number(config.budgetPercent);
    const leverage = config.leverage;
    const margin = budget * (budgetPercent / 100);
    const nominal = margin * leverage;
    const rawQuantity = nominal / currentPrice;

    // Округление под точность символа
    const contractInfo = await this.bingx.getContractInfo(signal.symbol);
    const quantityPrecision = contractInfo.data[0].quantityPrecision;
    const targetQuantity = this.roundToPrecision(rawQuantity, quantityPrecision);

    this.logger.log(
      `Сигнал #${signal.id} ${signal.symbol} ${signal.side}: ` +
      `цена=${currentPrice}, маржа=${margin}, номинал=${nominal}, qty=${targetQuantity}`,
    );

    // Создаём Trade и помечаем сигнал PROCESSING
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

  private roundToPrecision(value: number, precision: number): number {
    const factor = Math.pow(10, precision);
    return Math.floor(value * factor) / factor;
  }   






private async manageActiveTrades() {
    const activeTrades = await this.prisma.trade.findMany({
      where: { status: { in: ['ENTERING', 'OPEN', 'CLOSING'] } },
      include: { orders: true },
    });

    if (activeTrades.length === 0) return;

    // Один раз за тик получаем всю картину с биржи
    const openOrdersResp = await this.bingx.getOpenOrders();
    const allOpenOrders = Array.isArray(openOrdersResp.data?.orders)
      ? openOrdersResp.data.orders
      : [];

    const positionsResp = await this.bingx.getPositions();
    const allPositions = Array.isArray(positionsResp.data)
      ? positionsResp.data
      : [];

    for (const trade of activeTrades) {
      if (trade.status === 'ENTERING') {
        await this.manageEntering(trade, allOpenOrders, allPositions);
      }
      else if (trade.status === 'OPEN') {
        await this.manageOpen(trade, allOpenOrders, allPositions);
      }
      else if (trade.status === 'CLOSING') {
        await this.manageClosing(trade, allPositions);      
    }
}
  }









  
private async manageEntering(trade: any, allOpenOrders: any[], allPositions: any[]) {
    const entryOrder = trade.orders.find(
      (o: any) =>
        o.purpose === 'ENTRY' &&
        ['NEW', 'PENDING', 'PARTIALLYFILLED'].includes(o.status),
    );

    // Нет активного входного ордера — выставляем
    if (!entryOrder) {
      await this.placeEntryOrder(trade, allOpenOrders, allPositions);
      return;
    }

    // Висяк без биржевого id — пропускаем (подхват сработает отдельно)
    if (!entryOrder.bingxOrderId) {
      this.logger.warn(`Trade #${trade.id}: входной ордер без bingxId, пропускаю`);
      return;
    }

    // Есть активный ордер — проверяем его статус на бирже
    const resp = await this.bingx.queryOrder(trade.symbol, entryOrder.bingxOrderId);
    if (resp.code !== 0 || !resp.data?.order) {
      this.logger.warn(
        `Trade #${trade.id}: не удалось получить статус ордера ${entryOrder.bingxOrderId}: ${JSON.stringify(resp)}`,
      );
      return;
    }

    const exchangeOrder = resp.data.order;
    const status = exchangeOrder.status;
    const executedQty = Number(exchangeOrder.executedQty);
    const commission = Math.abs(Number(exchangeOrder.commission || 0));

    // Фиксируем актуальное состояние ордера в БД
    await this.prisma.order.update({
      where: { id: entryOrder.id },
      data: { status, executedQty, commission },
    });

    this.logger.log(
      `Trade #${trade.id} ${trade.symbol}: ордер ${entryOrder.bingxOrderId} статус=${status}, исполнено=${executedQty}`,
    );

    // Интерпретация по статусу
    if (status === 'FILLED') {
      await this.onEntryFilled(trade, allPositions);
    } else if (status === 'PARTIALLYFILLED') {
      // TODO под-шаг 4c: догон остатка
      this.logger.log(`Trade #${trade.id}: частичное исполнение, догон позже`);
    } else if (status === 'PENDING' || status === 'NEW') {
      // TODO под-шаг 4c: перестановка по сдвигу цены + таймаут
    } else if (status === 'CANCELLED' || status === 'FAILED') {
      // TODO: обработать отменённый/неудавшийся ордер
      this.logger.warn(`Trade #${trade.id}: входной ордер ${status}`);
    }
  }




  private async placeEntryOrder(trade: any, allOpenOrders: any[], allPositions: any[]) {
    const config = await this.prisma.symbolConfig.findUnique({
      where: { symbol: trade.symbol },
    });
    if (!config) return;

    // СВЕРКА 1: открытые ордера (фильтруем переданный список по символу/стороне)
    const existingEntryOrder = allOpenOrders.find(
      (o: any) =>
        o.symbol === trade.symbol &&
        o.positionSide === trade.side &&
        o.side === (trade.side === 'LONG' ? 'BUY' : 'SELL'),
    );

    if (existingEntryOrder) {
      const bingxOrderId = String(existingEntryOrder.orderID || existingEntryOrder.orderId);
      this.logger.warn(
        `Trade #${trade.id} ${trade.symbol}: на бирже уже висит входной ордер (${bingxOrderId}), подхватываю`,
      );
      await this.adoptEntryOrder(trade, existingEntryOrder);
      return;
    }

    // СВЕРКА 2: позиция (фильтруем переданный список)
    const existingPosition = allPositions.find(
      (p: any) =>
        p.symbol === trade.symbol &&
        p.positionSide === trade.side &&
        Number(p.positionAmt) !== 0,
    );

    if (existingPosition) {
      this.logger.warn(
        `Trade #${trade.id} ${trade.symbol}: позиция уже существует (${existingPosition.positionAmt}), подхватываю факт`,
      );
      await this.prisma.trade.update({
        where: { id: trade.id },
        data: {
          filledQuantity: Math.abs(Number(existingPosition.positionAmt)),
          avgEntryPrice: Number(existingPosition.avgPrice),
          positionId: String(existingPosition.positionId),
        },
      });
      return;
    }

    // Биржа чиста → выставляем (этот блок остаётся как был)
    const ticker = await this.bingx.getPrice(trade.symbol);
    const currentPrice = Number(ticker.data.price);
    const contractInfo = await this.bingx.getContractInfo(trade.symbol);
    const pricePrecision = contractInfo.data[0].pricePrecision;

    const offset = Number(config.entryPriceOffsetPercent) / 100;
    const rawPrice =
      trade.side === 'LONG'
        ? currentPrice * (1 + offset)
        : currentPrice * (1 - offset);
    const entryPrice = this.roundToPrecision(rawPrice, pricePrecision);

    const orderSide = trade.side === 'LONG' ? 'BUY' : 'SELL';
    const quantity = Number(trade.targetQuantity);

    const orderRecord = await this.prisma.order.create({
      data: {
        tradeId: trade.id,
        bingxOrderId: '',
        purpose: 'ENTRY',
        type: 'LIMIT',
        side: orderSide,
        positionSide: trade.side,
        price: entryPrice,
        quantity,
        status: 'NEW',
      },
    });

    await this.bingx.setLeverage(trade.symbol, trade.side, trade.leverage);

    const result = await this.bingx.placeOrder(
      trade.symbol,
      orderSide,
      trade.side,
      entryPrice,
      quantity,
    );

    if (result.code === 0 && result.data?.order) {
      const bingxOrderId = String(result.data.order.orderID || result.data.order.orderId);
      await this.prisma.order.update({
        where: { id: orderRecord.id },
        data: { bingxOrderId, status: 'PENDING' },
      });
      this.logger.log(
        `Trade #${trade.id} ${trade.symbol}: входной ордер выставлен, цена=${entryPrice}, qty=${quantity}, bingxId=${bingxOrderId}`,
      );
    } else {
      await this.prisma.order.update({
        where: { id: orderRecord.id },
        data: { status: 'FAILED' },
      });
      this.logger.error(`Trade #${trade.id}: не удалось выставить ордер: ${JSON.stringify(result)}`);
    }
  }

  // Подхват существующего на бирже входного ордера в нашу БД
  private async adoptEntryOrder(trade: any, exchangeOrder: any) {
    const bingxOrderId = String(exchangeOrder.orderID || exchangeOrder.orderId);

    // Уже есть запись с этим биржевым id?
    const existing = await this.prisma.order.findFirst({
      where: { tradeId: trade.id, bingxOrderId },
    });
    if (existing) return; // уже знаем про него — ничего не делаем

    // Есть "висяк" (ENTRY со статусом NEW и пустым id)? Дозаполняем его
    const orphan = await this.prisma.order.findFirst({
      where: { tradeId: trade.id, purpose: 'ENTRY', bingxOrderId: '' },
    });

    if (orphan) {
      await this.prisma.order.update({
        where: { id: orphan.id },
        data: {
          bingxOrderId,
          status: exchangeOrder.status,
          executedQty: Number(exchangeOrder.executedQty),
        },
      });
    } else {
      // Совсем нет записи — создаём с нуля из данных биржи
      await this.prisma.order.create({
        data: {
          tradeId: trade.id,
          bingxOrderId,
          purpose: 'ENTRY',
          type: 'LIMIT',
          side: exchangeOrder.side,
          positionSide: exchangeOrder.positionSide,
          price: Number(exchangeOrder.price),
          quantity: Number(exchangeOrder.origQty),
          status: exchangeOrder.status,
          executedQty: Number(exchangeOrder.executedQty),
        },
      });
    }
  }

  private async onEntryFilled(trade: any, allPositions: any[]) {
    // Сверка с реальной позицией на бирже
    const position = allPositions.find(
      (p: any) =>
        p.symbol === trade.symbol &&
        p.positionSide === trade.side &&
        Number(p.positionAmt) !== 0,
    );

    if (!position) {
      this.logger.warn(
        `Trade #${trade.id} ${trade.symbol}: ордер FILLED, но позиция не найдена — пропускаю тик`,
      );
      return;
    }

    const filledQuantity = Math.abs(Number(position.positionAmt));
    const avgEntryPrice = Number(position.avgPrice);
    const positionId = String(position.positionId);

    // Суммарная комиссия открытия по всем ENTRY-ордерам этой сделки
    const entryOrders = await this.prisma.order.findMany({
      where: { tradeId: trade.id, purpose: 'ENTRY' },
    });
    const totalEntryCommission = entryOrders.reduce(
      (sum, o) => sum + Math.abs(Number(o.commission)),
      0,
    );

    // Эффективная цена входа (комиссия вшита)
    const commissionPerUnit = filledQuantity > 0 ? totalEntryCommission / filledQuantity : 0;
    const effectiveEntryPrice =
      trade.side === 'LONG'
        ? avgEntryPrice + commissionPerUnit
        : avgEntryPrice - commissionPerUnit;

    // Целевые цены закрытия (от эффективной цены)
    const config = await this.prisma.symbolConfig.findUnique({
      where: { symbol: trade.symbol },
    });
    const tpPercent = Number(config!.takeProfitPercent) / 100;
    const slPercent = Number(config!.stopLossPercent) / 100;

    const takeProfitPrice =
      trade.side === 'LONG'
        ? effectiveEntryPrice * (1 + tpPercent)
        : effectiveEntryPrice * (1 - tpPercent);
    const stopLossPrice =
      trade.side === 'LONG'
        ? effectiveEntryPrice * (1 - slPercent)
        : effectiveEntryPrice * (1 + slPercent);

    await this.prisma.trade.update({
      where: { id: trade.id },
      data: {
        status: 'OPEN',
        filledQuantity,
        avgEntryPrice,
        effectiveEntryPrice,
        positionId,
        takeProfitPrice,
        stopLossPrice,
      },
    });

    this.logger.log(
      `Trade #${trade.id} ${trade.symbol}: позиция ОТКРЫТА. ` +
      `avg=${avgEntryPrice}, eff=${effectiveEntryPrice.toFixed(6)}, ` +
      `qty=${filledQuantity}, TP=${takeProfitPrice.toFixed(6)}, SL=${stopLossPrice.toFixed(6)}`,
    );
  }
  
private async manageOpen(trade: any, allOpenOrders: any[], allPositions: any[]) {
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
    const stopPrice = this.roundToPrecision(rawStop, pricePrecision);

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

  private async onPositionClosed(trade: any) {
    this.logger.log(`Trade #${trade.id} ${trade.symbol}: позиция закрыта на бирже, фиксирую результат`);

    let realizedPnl: number | null = null;

    if (trade.positionId) {
      // Ищем в истории позиций по positionId
      const now = Date.now();
      const start = now - 7 * 24 * 60 * 60 * 1000; // последние 7 дней
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
        this.logger.warn(
          `Trade #${trade.id}: позиция ${trade.positionId} не найдена в истории`,
        );
      }
    }

    // Помечаем активные ордера сделки финально (биржа их сняла, обновим БД)
    await this.prisma.order.updateMany({
      where: {
        tradeId: trade.id,
        status: { in: ['NEW', 'PENDING'] },
      },
      data: { status: 'CANCELLED' },
    });

    // Закрываем сделку
    await this.prisma.trade.update({
      where: { id: trade.id },
      data: {
        status: 'CLOSED',
        realizedPnl,
      },
    });

    // Сигнал — завершён
    await this.prisma.signal.update({
      where: { id: trade.signalId },
      data: { status: 'COMPLETED' },
    });

    this.logger.log(`Trade #${trade.id} ${trade.symbol}: ЗАКРЫТА, realizedPnl=${realizedPnl}`);
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

private async manageLossExit(trade: any, position: any) {
    const quantity = Math.abs(Number(position.positionAmt));
    if (quantity <= 0) return; // позиции нет — закрытие поймает manageClosing

    const closeSide = trade.side === 'LONG' ? 'SELL' : 'BUY';

    const ticker = await this.bingx.getPrice(trade.symbol);
    const currentPrice = Number(ticker.data.price);

    const contractInfo = await this.bingx.getContractInfo(trade.symbol);
    const pricePrecision = contractInfo.data[0].pricePrecision;
    const closePrice = this.roundToPrecision(currentPrice, pricePrecision);

    // Активный CLOSE-ордер?
    const existingClose = trade.orders.find(
      (o: any) => o.purpose === 'CLOSE' && ['NEW', 'PENDING'].includes(o.status),
    );

    // Отменяем старый (переставляем каждый тик по текущей цене)
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


private async manageClosing(trade: any, allPositions: any[]) {
    const position = allPositions.find(
      (p: any) =>
        p.symbol === trade.symbol &&
        p.positionSide === trade.side &&
        Number(p.positionAmt) !== 0,
    );

    if (!position) {
      await this.onPositionClosed(trade);
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
}