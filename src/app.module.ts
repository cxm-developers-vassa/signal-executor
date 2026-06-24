import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SignalsModule } from './signals/signals.module';
import { ConfigModule } from '@nestjs/config';
import { BingxModule } from './bingx/bingx.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }),
    SignalsModule,
    BingxModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
