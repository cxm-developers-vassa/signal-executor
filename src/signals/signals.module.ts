import { Module } from '@nestjs/common';
import { SignalsController } from './signals.controller';
import { SignalsService } from './signals.service';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  controllers: [SignalsController],
  providers: [SignalsService, PrismaService],
})
export class SignalsModule {}