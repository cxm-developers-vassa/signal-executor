import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { BingxService } from '../bingx/bingx.service';
import { roundToPrecision } from './trading.utils';
import { SignalProcessorService } from './signal-processor.service';
import { EntryService } from './entry.service';
import { PositionService } from './position.service';

@Injectable()
export class TradingService implements OnModuleInit {
  private readonly logger = new Logger(TradingService.name);
  private isRunning = false;
  private lastHeartbeatAt: Date | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly bingx: BingxService,
    private readonly signals: SignalProcessorService,
    private readonly entry: EntryService,
    private readonly position: PositionService,
  ) {}

  async onModuleInit() {    
     await this.reconcileOnStartup();
     this.logger.log('TradingService запущен');
    await this.tick();
  }






  @Interval(5000)
  async tick() {
    if (this.isRunning) {
      this.logger.warn('Предыдущий тик ещё работает, пропускаю');
      return;
    }
    this.isRunning = true;
    try {
      // Собираем позиции один раз для всего тика
      const positionsResp = await this.bingx.getPositions();
      const allPositions = Array.isArray(positionsResp.data) ? positionsResp.data : [];

      await this.signals.processNewSignals(allPositions);
      await this.manageActiveTrades(allPositions);
      await this.maybeHeartbeat();
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        this.logger.warn('Запрос к бирже прерван по таймауту, повтор на следующем тике');
      } else {
      this.logger.error('Ошибка в тике', error);
      }
    } finally {
      this.isRunning = false;
    }    
  }






  
private async maybeHeartbeat() {
    const now = Date.now();
    const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000; // 10 минут

    // Ещё не время
    if (this.lastHeartbeatAt && now - this.lastHeartbeatAt.getTime() < HEARTBEAT_INTERVAL_MS) {
      return;
    }

    const activeTrades = await this.prisma.trade.count({
      where: { status: { in: ['ENTERING', 'OPEN', 'CLOSING'] } },
    });

    this.logger.log(`💓 Бот жив | тик работает | активных сделок: ${activeTrades}`);
    this.lastHeartbeatAt = new Date();
  }



  





private async manageActiveTrades(allPositions: any[]) {
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
    

    for (const trade of activeTrades) {
      if (trade.status === 'ENTERING') {
        await this.entry.manageEntering(trade, allOpenOrders, allPositions);
      }
      else if (trade.status === 'OPEN') {
        await this.position.manageOpen(trade, allOpenOrders, allPositions);
      }
      else if (trade.status === 'CLOSING') {
        await this.position.manageClosing(trade, allPositions);      
    }
}
}

async reconcileOnStartup() {
    this.logger.log('=== Reconciliation при старте ===');

    const activeTrades = await this.prisma.trade.findMany({
      where: { status: { in: ['ENTERING', 'OPEN', 'CLOSING'] } },
      include: { orders: true },
    });

    // Получаем позиции с биржи ВСЕГДА (нужны для обоих шагов)
    const positionsResp = await this.bingx.getPositions();
    const allPositions = Array.isArray(positionsResp.data) ? positionsResp.data : [];

    // === Шаг 1: сверка активных сделок из БД ===
    if (activeTrades.length === 0) {
      this.logger.log('Нет активных сделок для сверки');
    } else {
      this.logger.log(`Сверяю ${activeTrades.length} активных сделок с биржей`);
      for (const trade of activeTrades) {
        await this.reconcileTrade(trade, allPositions);
      }
    }

    // === Шаг 2: осиротевшие позиции (выполняется ВСЕГДА) ===
    for (const position of allPositions) {
      if (Number(position.positionAmt) === 0) continue;
      const matched = activeTrades.find(
        (t: any) => t.symbol === position.symbol && t.side === position.positionSide,
      );
      if (!matched) {
        this.logger.warn(
          `⚠️ Осиротевшая позиция на бирже: ${position.symbol} ${position.positionSide} ` +
          `${position.positionAmt} — нет активной сделки в БД (не трогаю)`,
        );
      }
    }

    this.logger.log('=== Reconciliation завершён ===');
  }



private async reconcileTrade(trade: any, allPositions: any[]) {
    const position = allPositions.find(
      (p: any) =>
        p.symbol === trade.symbol &&
        p.positionSide === trade.side &&
        Number(p.positionAmt) !== 0,
    );

    if (position) {
      if (trade.status === 'ENTERING') {
        this.logger.log(`Trade #${trade.id} ${trade.symbol}: позиция есть, вход завершён → OPEN`);
        await this.entry.onEntryFilled(trade, allPositions);
      } else {
        this.logger.log(`Trade #${trade.id} ${trade.symbol}: позиция жива (${position.positionAmt}), статус ${trade.status}`);
      }
    } else {
      const totalFilled = trade.orders
        .filter((o: any) => o.purpose === 'ENTRY')
        .reduce((sum: number, o: any) => sum + Number(o.executedQty), 0);

      if (totalFilled > 0 || trade.status === 'OPEN' || trade.status === 'CLOSING') {
        this.logger.log(`Trade #${trade.id} ${trade.symbol}: позиции нет, сделка закрылась → фиксирую результат`);
        await this.position.onPositionClosed(trade);
      } else {
        this.logger.log(`Trade #${trade.id} ${trade.symbol}: позиции нет, вход не состоялся → CANCELLED`);
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
  }



  }













  

  

  
  


 

  



