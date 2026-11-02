import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  BetLabEventCategory,
  BetLabEventLevel,
} from '../enums/bet-lab-event.enum';
import { BetLabEvent } from '../schemas/bet-lab-event.schema';

@Injectable()
export class BetLabEventService {
  private readonly logger = new Logger(BetLabEventService.name);

  constructor(
    @InjectModel(BetLabEvent.name)
    private readonly eventModel: Model<BetLabEvent>,
  ) {}

  async record(input: {
    level: BetLabEventLevel;
    category: BetLabEventCategory;
    action: string;
    message: string;
    userId?: string;
    eventId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.eventModel.create({
        ...input,
        action: input.action.slice(0, 120),
        message: input.message.slice(0, 2000),
      });
    } catch (error) {
      // Operational telemetry must never make a wallet or ticket operation fail.
      this.logger.error(
        `Could not persist Bet Lab event (${input.action}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
