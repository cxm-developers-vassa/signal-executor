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

  constructor(
    private readonly prisma: PrismaService,
    private readonly bingx: BingxService,
    private readonly signals: SignalProcessorService,
    private readonly entry: EntryService,
    private readonly position: PositionService,
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
      await this.signals.processNewSignals();
      await this.manageActiveTrades();      
    } catch (error) {
      this.logger.error('Ошибка в тике', error);
    } finally {
      this.isRunning = false;
    }
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













  

  

  
  


 

  




}