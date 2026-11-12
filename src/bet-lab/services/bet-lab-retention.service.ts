import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BackgroundWorkLimiterService } from '../../common/background-work/background-work-limiter.service';
import { BET_LAB_CONFIG } from '../config/bet-lab.config';
import {
  BetLabEventCategory,
  BetLabEventLevel,
} from '../enums/bet-lab-event.enum';
import { BET_LAB_TERMINAL_TICKET_STATUSES } from '../enums/bet-lab-ticket-status.enum';
import { BetLabEvent } from '../schemas/bet-lab-event.schema';
import { BetLabTicket } from '../schemas/bet-lab-ticket.schema';
import { BetLabEventService } from './bet-lab-event.service';

@Injectable()
export class BetLabRetentionService implements OnModuleInit {
  private readonly logger = new Logger(BetLabRetentionService.name);

  constructor(
    @InjectModel(BetLabTicket.name)
    private readonly ticketModel: Model<BetLabTicket>,
    @InjectModel(BetLabEvent.name)
    private readonly eventModel: Model<BetLabEvent>,
    private readonly events: BetLabEventService,
    private readonly backgroundWork: BackgroundWorkLimiterService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.pruneExpiredRecords();
    } catch (error) {
      this.logger.error(
        `Initial Bet Lab retention cleanup failed: ${this.errorMessage(error)}`,
      );
    }
  }

  @Cron('0 3 * * *', { timeZone: 'Africa/Lagos' })
  async runDailyRetention(): Promise<void> {
    try {
      await this.pruneExpiredRecords();
    } catch (error) {
      const message = this.errorMessage(error);
      this.logger.error(`Daily Bet Lab retention cleanup failed: ${message}`);
      await this.events.record({
        level: BetLabEventLevel.ERROR,
        category: BetLabEventCategory.RETENTION,
        action: 'RETENTION_CLEANUP_FAILED',
        message,
      });
    }
  }

  async pruneExpiredRecords() {
    const releasePermit = await this.backgroundWork.acquire('bet-lab:retention');
    try {
      const now = new Date();
      const ticketsDeleted = await this.deleteInBatches(this.ticketModel, {
        status: { $in: BET_LAB_TERMINAL_TICKET_STATUSES },
        visibleUntil: { $lte: now },
      });
      const eventCutoff = new Date(
        now.getTime() -
          BET_LAB_CONFIG.monitor.eventRetentionDays * 24 * 60 * 60 * 1000,
      );
      const oldEventsDeleted = await this.deleteInBatches(this.eventModel, {
        createdAt: { $lt: eventCutoff },
      });
      const result = {
        ticketsDeleted,
        oldEventsDeleted,
        batchSize: BET_LAB_CONFIG.retention.batchSize,
        maximumBatchesPerCollection: BET_LAB_CONFIG.retention.maximumBatchesPerRun,
        runAt: now,
      };
      await this.events.record({
        level: BetLabEventLevel.INFO,
        category: BetLabEventCategory.RETENTION,
        action: 'RETENTION_CLEANUP_COMPLETED',
        message:
          'Bet Lab expired settled-ticket details and old operational events were cleaned up in bounded batches.',
        metadata: result,
      });
      return result;
    } finally {
      releasePermit();
    }
  }

  private async deleteInBatches(
    model: Model<any>,
    filter: Record<string, any>,
  ): Promise<number> {
    const { batchSize, maximumBatchesPerRun } = BET_LAB_CONFIG.retention;
    let deletedTotal = 0;

    for (let batch = 0; batch < maximumBatchesPerRun; batch += 1) {
      const rows = await model
        .find(filter)
        .select('_id')
        .sort({ _id: 1 })
        .limit(batchSize)
        .lean()
        .exec() as Array<{ _id: unknown }>;

      if (!rows.length) break;
      const result = await model
        .deleteMany({ _id: { $in: rows.map((row) => row._id) } })
        .exec();
      deletedTotal += result.deletedCount ?? 0;
      if (rows.length < batchSize) break;
    }

    return deletedTotal;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
