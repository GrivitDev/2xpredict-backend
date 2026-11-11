import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PaymentsService } from './payments.service';

const INITIAL_DELAY_MS = 5_000;
const POLL_INTERVAL_MS = 15_000;
const BATCH_SIZE = 10;

/**
 * Durable payment-approval recovery worker.
 * Payment rows in PROCESSING are the queue records; an expired lease can be
 * claimed by exactly one worker through PaymentsService's atomic state update.
 */
@Injectable()
export class PaymentProcessingWorker
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PaymentProcessingWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;

  constructor(private readonly paymentsService: PaymentsService) {}

  onModuleInit(): void {
    this.schedule(INITIAL_DELAY_MS);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.runPass(), delayMs);
    this.timer.unref?.();
  }

  private async runPass(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;

    try {
      const recovered = await this.paymentsService.recoverStalePaymentProcessing(
        BATCH_SIZE,
      );
      if (recovered > 0) {
        this.logger.log(`Recovered ${recovered} payment approval(s).`);
      }

      const notificationsRecovered =
        await this.paymentsService.recoverPendingPaymentNotifications(20);
      if (notificationsRecovered > 0) {
        this.logger.log(
          `Completed ${notificationsRecovered} payment notification outbox record(s).`,
        );
      }

      // Never delete a gateway payment solely because its initialization
      // response was lost. Move old initializing rows to UNKNOWN so clients
      // and support staff know they must verify the existing reference.
      await this.paymentsService.markExpiredGatewayInitializationsUnknown();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Payment recovery pass failed: ${message}`);
    } finally {
      this.running = false;
      this.schedule(POLL_INTERVAL_MS);
    }
  }
}
