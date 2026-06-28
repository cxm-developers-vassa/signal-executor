import { Module } from '@nestjs/common';
import { TradingService } from './trading.service';
import { BingxModule } from '../bingx/bingx.module';

@Module({
  imports: [BingxModule],
  providers: [TradingService],
})
export class TradingModule {}