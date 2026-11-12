import { Global, Module } from '@nestjs/common';
import { BackgroundWorkLimiterService } from './background-work-limiter.service';

/** Shared singleton limiter for background work across application modules. */
@Global()
@Module({
  providers: [BackgroundWorkLimiterService],
  exports: [BackgroundWorkLimiterService],
})
export class BackgroundWorkModule {}
