import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
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
    const now = new Date();
    const ticketResult = await this.ticketModel
      .deleteMany({
        status: { $in: BET_LAB_TERMINAL_TICKET_STATUSES },
        visibleUntil: { $lte: now },
      })
      .exec();
    const eventCutoff = new Date(
      now.getTime() -
        BET_LAB_CONFIG.monitor.eventRetentionDays * 24 * 60 * 60 * 1000,
    );
    const eventResult = await this.eventModel
      .deleteMany({ createdAt: { $lt: eventCutoff } })
      .exec();
    const result = {
      ticketsDeleted: ticketResult.deletedCount ?? 0,
      oldEventsDeleted: eventResult.deletedCount ?? 0,
      runAt: now,
    };
    await this.events.record({
      level: BetLabEventLevel.INFO,
      category: BetLabEventCategory.RETENTION,
      action: 'RETENTION_CLEANUP_COMPLETED',
      message:
        'Bet Lab expired settled-ticket details and old operational events were cleaned up.',
      metadata: result,
    });
    return result;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
