import { Module } from '@nestjs/common';
import { TradingService } from './trading.service';
import { BingxModule } from '../bingx/bingx.module';
import { SignalProcessorService } from './signal-processor.service';
import { EntryService } from './entry.service';
import { PositionService } from './position.service';

@Module({
  imports: [BingxModule],
  providers: [TradingService, SignalProcessorService, EntryService, PositionService],
})
export class TradingModule {}