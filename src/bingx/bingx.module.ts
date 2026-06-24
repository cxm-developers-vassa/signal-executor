import { Module } from '@nestjs/common';
import { BingxController } from './bingx.controller';
import { BingxService } from './bingx.service';

@Module({
  controllers: [BingxController],
  providers: [BingxService],
})
export class BingxModule {}