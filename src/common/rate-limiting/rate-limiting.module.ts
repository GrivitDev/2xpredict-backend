import { Global, Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';

/**
 * Shared in-process throttler storage for authentication and OTP endpoints.
 * Sensitive routes opt in individually with ThrottlerGuard and @Throttle.
 */
@Global()
@Module({
  imports: [
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60_000,
        limit: 120,
      },
    ]),
  ],
  exports: [ThrottlerModule],
})
export class RateLimitingModule {}
