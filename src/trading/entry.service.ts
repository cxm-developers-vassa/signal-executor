import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BingxService } from '../bingx/bingx.service';
import { roundToPrecision } from './trading.utils';

@Injectable()
export class EntryService {
  private readonly logger = new Logger(EntryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bingx: BingxService,
  ) {}



async manageEntering(trade: any, allOpenOrders: any[], allPositions: any[]) {
    const entryOrder = trade.orders.find(
      (o: any) =>
        o.purpose === 'ENTRY' &&
        ['NEW', 'PENDING', 'PARTIALLYFILLED'].includes(o.status),
    );

    // Нет активного ордера — выставляем (первый раз)
    if (!entryOrder) {
      await this.placeEntryOrder(trade, allOpenOrders, allPositions);
      return;
    }

    // Висяк без биржевого id — пропускаем
    if (!entryOrder.bingxOrderId) {
      this.logger.warn(`Trade #${trade.id}: входной ордер без bingxId, пропускаю`);
      return;
    }

    // Проверяем статус ордера на бирже
    const resp = await this.bingx.queryOrder(trade.symbol, entryOrder.bingxOrderId);
    if (resp.code !== 0 || !resp.data?.order) {
      this.logger.warn(`Trade #${trade.id}: не удалось получить статус ордера`);
      return;
    }

    const exchangeOrder = resp.data.order;
    const status = exchangeOrder.status;
    const executedQty = Number(exchangeOrder.executedQty);
    const commission = Math.abs(Number(exchangeOrder.commission || 0));

    await this.prisma.order.update({
      where: { id: entryOrder.id },
      data: { status, executedQty, commission },
    });

    // Полностью исполнен → открываем позицию
    if (status === 'FILLED') {
      await this.onEntryFilled(trade, allPositions);
      return;
    }

    // Проверяем дедлайн
    const deadlinePassed = trade.entryDeadline && new Date() > new Date(trade.entryDeadline);

    if (deadlinePassed) {
      await this.finalizeEntryOnDeadline(trade, entryOrder, allPositions);
      return;
    }

    // Дедлайн не истёк → продолжаем набор: перестановка при сдвиге цены
    await this.repositionEntryOrder(trade, entryOrder, allPositions);
  }



  
private async finalizeEntryOnDeadline(trade: any, entryOrder: any, allPositions: any[]) {
    // Отменяем активный ордер
    if (entryOrder.bingxOrderId) {
      await this.bingx.cancelOrder(trade.symbol, entryOrder.bingxOrderId);
      await this.prisma.order.update({
        where: { id: entryOrder.id },
        data: { status: 'CANCELLED' },
      });
    }

    // Смотрим реальную позицию — есть ли что-то набранное
    const position = allPositions.find(
      (p: any) =>
        p.symbol === trade.symbol &&
        p.positionSide === trade.side &&
        Number(p.positionAmt) !== 0,
    );

    if (position) {
      // Есть позиция (хоть частичная) → принимаем, идём в OPEN
      this.logger.log(
        `Trade #${trade.id} ${trade.symbol}: дедлайн истёк, принимаю набранную позицию ${position.positionAmt}`,
      );
      await this.onEntryFilled(trade, allPositions);
    } else {
      // Ничего не набрали → отказ от входа
      this.logger.warn(
        `Trade #${trade.id} ${trade.symbol}: дедлайн истёк, позиции нет — отмена входа`,
      );
      await this.prisma.trade.update({
        where: { id: trade.id },
        data: { status: 'CANCELLED' },
      });
      await this.prisma.signal.update({
        where: { id: trade.signalId },
        data: { status: 'CANCELLED' },
      });
    }
  }




private async repositionEntryOrder(trade: any, entryOrder: any, allPositions: any[]) {
    const config = await this.prisma.symbolConfig.findUnique({
      where: { symbol: trade.symbol },
    });
    if (!config) return;

    const ticker = await this.bingx.getPrice(trade.symbol);
    const currentPrice = Number(ticker.data.price);
    const orderPrice = Number(entryOrder.price);

    const threshold = Number(config.repriceThresholdPercent) / 100;
    const drift = Math.abs(currentPrice - orderPrice) / orderPrice;

    // Цена не ушла за порог — ждём, не трогаем
    if (drift < threshold) return;

    // Цена ушла → отменяем старый ордер
    await this.bingx.cancelOrder(trade.symbol, entryOrder.bingxOrderId);

    // Узнаём фактический статус после отмены (сколько успело исполниться)
    const resp = await this.bingx.queryOrder(trade.symbol, entryOrder.bingxOrderId);
    const executedQty = Number(resp.data?.order?.executedQty || entryOrder.executedQty);
    const commission = Math.abs(Number(resp.data?.order?.commission || entryOrder.commission));

    await this.prisma.order.update({
      where: { id: entryOrder.id },
      data: { status: 'CANCELLED', executedQty, commission },
    });

    // Сколько уже в позиции (истина — реальная позиция)
    const position = allPositions.find(
      (p: any) =>
        p.symbol === trade.symbol &&
        p.positionSide === trade.side &&
        Number(p.positionAmt) !== 0,
    );
    const alreadyFilled = position ? Math.abs(Number(position.positionAmt)) : 0;

    // Остаток для добора
    const remaining = Number(trade.targetQuantity) - alreadyFilled;

    const contractInfo = await this.bingx.getContractInfo(trade.symbol);
    const quantityPrecision = contractInfo.data[0].quantityPrecision;
    const pricePrecision = contractInfo.data[0].pricePrecision;
    const remainingRounded = roundToPrecision(remaining, quantityPrecision);

    // Остаток слишком мал — считаем, что набрали достаточно, идём в OPEN
    if (remainingRounded <= 0) {
      await this.onEntryFilled(trade, allPositions);
      return;
    }

    // Новая цена входа (marketable, как в placeEntryOrder)
    const offset = Number(config.entryPriceOffsetPercent) / 100;
    const rawPrice =
      trade.side === 'LONG'
        ? currentPrice * (1 + offset)
        : currentPrice * (1 - offset);
    const newPrice = roundToPrecision(rawPrice, pricePrecision);
    const orderSide = trade.side === 'LONG' ? 'BUY' : 'SELL';

    // Новая запись + выставление на остаток
    const orderRecord = await this.prisma.order.create({
      data: {
        tradeId: trade.id,
        bingxOrderId: '',
        purpose: 'ENTRY',
        type: 'LIMIT',
        side: orderSide as any,
        positionSide: trade.side,
        price: newPrice,
        quantity: remainingRounded,
        status: 'NEW',
      },
    });

    const result = await this.bingx.placeOrder(
      trade.symbol, orderSide as 'BUY' | 'SELL', trade.side, newPrice, remainingRounded,
    );

    if (result.code === 0 && result.data?.order) {
      const bingxOrderId = String(result.data.order.orderID || result.data.order.orderId);
      await this.prisma.order.update({
        where: { id: orderRecord.id },
        data: { bingxOrderId, status: 'PENDING' },
      });
      this.logger.log(
        `Trade #${trade.id} ${trade.symbol}: вход переставлен на ${newPrice}, остаток qty=${remainingRounded}, bingxId=${bingxOrderId}`,
      );
    } else {
      await this.prisma.order.update({
        where: { id: orderRecord.id }, data: { status: 'FAILED' },
      });
      this.logger.error(`Trade #${trade.id}: не переставить вход: ${JSON.stringify(result)}`);
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
    const entryPrice = roundToPrecision(rawPrice, pricePrecision);

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



  async onEntryFilled(trade: any, allPositions: any[]) {
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
}