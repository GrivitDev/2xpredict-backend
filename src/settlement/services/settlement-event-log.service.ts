import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { SettlementEvent } from '../schemas/settlement-event.schema';
import { SettlementEventLevel } from '../enums/settlement-event-level.enum';

@Injectable()
export class SettlementEventLogService {
  private readonly logger = new Logger(SettlementEventLogService.name);
  constructor(
    @InjectModel(SettlementEvent.name)
    private readonly eventModel: Model<SettlementEvent>,
  ) {}

  async write(input: {
    level: SettlementEventLevel;
    action: string;
    message: string;
    eventId?: string;
    jobKey?: string;
    runId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.eventModel.create({ ...input, occurredAt: new Date() });
    } catch (error) {
      this.logger.error(
        `Could not persist settlement event ${input.action}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

