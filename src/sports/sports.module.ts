import { Module } from '@nestjs/common';
import { SportsDataModule } from './sports-data.module';

/** Public NestJS entry point for the normalized Sports data layer. */
@Module({
  imports: [SportsDataModule],
  exports: [SportsDataModule],
})
export class SportsModule {}

