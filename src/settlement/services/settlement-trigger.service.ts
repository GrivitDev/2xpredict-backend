import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { MarketPrediction } from '../../predictions-engine/schemas/market-prediction.schema';
import { BetLabTicket } from '../../bet-lab/schemas/bet-lab-ticket.schema';
import { PredictionStatus } from '../../predictions-engine/enums/prediction-status.enum';
import { PredictionSettlementOutcome } from '../enums/settlement-prediction-outcome.enum';
import { BetLabLegStatus } from '../../bet-lab/enums/bet-lab-leg-status.enum';
import { BetLabTicketStatus } from '../../bet-lab/enums/bet-lab-ticket-status.enum';
import { SETTLEMENT_CONFIG } from '../config/settlement.config';
import { SettlementQueueService } from './settlement-queue.service';

const DISCOVERY_INTERVAL_MS = SETTLEMENT_CONFIG.queue.discoveryIntervalMs;
const MAX_REASON_EXAMPLES = 3;

type EventIdRow = { _id: unknown };
type QueueResult = {
  enqueued?: boolean;
  reason?: string;
  jobKey?: string;
  scheduledAt?: Date;
};

@Injectable()
export class SettlementTriggerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SettlementTriggerService.name);
  private scanTimer?: ReturnType<typeof setInterval>;
  private scanRunning = false;

  constructor(
    private readonly queue: SettlementQueueService,
    @InjectModel(MarketPrediction.name)
    private readonly marketPredictionModel: Model<MarketPrediction>,
    @InjectModel(BetLabTicket.name)
    private readonly ticketModel: Model<BetLabTicket>,
  ) {}

  onModuleInit(): void {
    // Startup discovery plus a durable periodic recovery net for missed events.
    void this.scanPredictionEvents();
    this.scanTimer = setInterval(() => {
      void this.scanPredictionEvents();
    }, DISCOVERY_INTERVAL_MS);
    this.scanTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.scanTimer) clearInterval(this.scanTimer);
  }

  async onTargetsCreated(
    eventIds: string[],
    triggerReason: 'PREDICTION_CREATED' | 'BET_LAB_TICKET_CREATED',
  ): Promise<void> {
    const uniqueEventIds = [...new Set(eventIds.map((id) => String(id ?? '').trim()).filter(Boolean))];
    const batchSize = Math.max(1, SETTLEMENT_CONFIG.queue.discoveryBatchSize);
    for (let offset = 0; offset < uniqueEventIds.length; offset += batchSize) {
      const batch = uniqueEventIds.slice(offset, offset + batchSize);
      await Promise.all(batch.map(async (eventId) => {
        try {
          const result = await this.queue.enqueueIfKickoffEligible(eventId, undefined, triggerReason);
          if (!result.enqueued && this.isUnexpectedQueueRejection(result.reason)) {
            this.logger.warn(`Settlement target creation was not queued for ${eventId}: ${result.reason ?? 'UNKNOWN_REASON'}.`);
          }
        } catch (error) {
          this.logger.error(`Settlement discovery failed for ${eventId}: ${this.errorMessage(error)}`);
        }
      }));
    }
  }

  /** Summary updates trigger a fresh fingerprint evaluation. */
  async onSummaryUpdated(eventId: string, leagueId?: string): Promise<void> {
    const id = String(eventId ?? '').trim();
    if (!id) return;
    try {
      const result = await this.queue.enqueueIfKickoffEligible(id, leagueId, 'SUMMARY_UPDATED');
      if (result.enqueued) {
        this.logger.log(`Settlement re-evaluation queued for fixture ${id} (${result.jobKey ?? 'job key unavailable'}).`);
      } else if (this.isUnexpectedQueueRejection(result.reason)) {
        this.logger.warn(`Summary changed for ${id}, but settlement was not queued: ${result.reason ?? 'UNKNOWN_REASON'}.`);
      }
    } catch (error) {
      this.logger.error(`Summary-triggered settlement evaluation failed for ${id}: ${this.errorMessage(error)}`);
    }
  }

  /**
   * Recovery scan for unresolved Prediction Engine selections, open Bet Lab legs,
   * and abandoned worker leases. The queue remains the single owner of kickoff
   * eligibility and job-state transitions.
   */
  async scanPredictionEvents(): Promise<void> {
    if (this.scanRunning) {
      this.logger.debug('Settlement discovery scan is already running; skipping overlapping scan.');
      return;
    }

    this.scanRunning = true;
    const startedAt = Date.now();
    try {
      // Lease recovery must run even if one of the target collections is unavailable.
      try {
        const recoveredLeases = await this.queue.recoverExpiredProcessingJobs();
        if (recoveredLeases > 0) {
          this.logger.warn(`Recovered ${recoveredLeases} expired settlement worker lease(s).`);
        }
      } catch (error) {
        this.logger.error(`Settlement lease recovery failed: ${this.errorMessage(error)}`);
      }

      const persistedOutcomes = Object.values(PredictionSettlementOutcome);
      const [engineResult, betLabResult] = await Promise.all([
        this.loadPredictionEventIds(persistedOutcomes),
        this.loadBetLabEventIds(),
      ]);

      if (engineResult.error) {
        this.logger.error(`Prediction Engine settlement discovery query failed: ${engineResult.error}`);
      }
      if (betLabResult.error) {
        this.logger.error(`Bet Lab settlement discovery query failed: ${betLabResult.error}`);
      }
      if (engineResult.error && betLabResult.error) {
        this.logger.error('Settlement discovery aborted: both target-source queries failed; the next periodic scan will retry.');
        return;
      }

      const eventIds = [...new Set([...engineResult.rows, ...betLabResult.rows]
        .map((row) => String(row._id ?? '').trim())
        .filter(Boolean))];
      const reasonCounts: Record<string, number> = {};
      const reasonExamples: Record<string, string[]> = {};
      let queued = 0;
      let failed = 0;
      const batchSize = Math.max(1, SETTLEMENT_CONFIG.queue.discoveryBatchSize);

      for (let offset = 0; offset < eventIds.length; offset += batchSize) {
        const batch = eventIds.slice(offset, offset + batchSize);
        const results = await Promise.all(batch.map(async (eventId) => {
          try {
            const result = await this.queue.enqueueIfKickoffEligible(eventId, undefined, 'KICKOFF_SCAN') as QueueResult;
            const reason = result.reason ?? (result.enqueued ? 'QUEUED' : 'NO_REASON_RETURNED');
            reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
            if (!result.enqueued && this.isUnexpectedQueueRejection(reason)) {
              const examples = reasonExamples[reason] ?? (reasonExamples[reason] = []);
              if (examples.length < MAX_REASON_EXAMPLES) examples.push(eventId);
            }
            return result;
          } catch (error) {
            failed += 1;
            const reason = 'QUEUE_EXCEPTION';
            reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
            const examples = reasonExamples[reason] ?? (reasonExamples[reason] = []);
            if (examples.length < MAX_REASON_EXAMPLES) examples.push(eventId);
            this.logger.error(`Settlement scan failed for event ${eventId}: ${this.errorMessage(error)}`);
            return null;
          }
        }));
        queued += results.filter((result) => result?.enqueued === true).length;
      }

      const durationMs = Date.now() - startedAt;
      this.logger.log(
        `Settlement discovery completed in ${durationMs}ms: predictionSourceEvents=${engineResult.rows.length}, betLabSourceEvents=${betLabResult.rows.length}, uniqueEvents=${eventIds.length}, queuedOrAwakened=${queued}, queueExceptions=${failed}, batchSize=${batchSize}, reasons=${JSON.stringify(reasonCounts)}, examples=${JSON.stringify(reasonExamples)}.`,
      );
    } catch (error) {
      this.logger.error(`Settlement prediction discovery scan failed: ${this.errorMessage(error)}`);
    } finally {
      this.scanRunning = false;
    }
  }

  private async loadPredictionEventIds(persistedOutcomes: string[]): Promise<{ rows: EventIdRow[]; error?: string }> {
    try {
      const rows = await this.marketPredictionModel.aggregate([
        {
          $match: {
            eventId: { $exists: true, $nin: ['', null] },
            status: { $nin: [PredictionStatus.UNAVAILABLE, PredictionStatus.FAILED] },
          },
        },
        { $unwind: '$selections' },
        {
          $match: {
            'selections.actualOutcome': { $nin: persistedOutcomes },
            'selections.status': { $nin: [PredictionStatus.UNAVAILABLE, PredictionStatus.FAILED] },
          },
        },
        { $group: { _id: '$eventId' } },
      ]).exec() as EventIdRow[];
      return { rows };
    } catch (error) {
      return { rows: [], error: this.errorMessage(error) };
    }
  }

  private async loadBetLabEventIds(): Promise<{ rows: EventIdRow[]; error?: string }> {
    try {
      const rows = await this.ticketModel.aggregate([
        {
          $match: {
            status: { $in: [BetLabTicketStatus.OPEN, BetLabTicketStatus.PENDING_SETTLEMENT] },
          },
        },
        { $unwind: '$legs' },
        {
          $match: {
            'legs.status': BetLabLegStatus.OPEN,
            'legs.eventId': { $exists: true, $nin: ['', null] },
          },
        },
        { $group: { _id: '$legs.eventId' } },
      ]).exec() as EventIdRow[];
      return { rows };
    } catch (error) {
      return { rows: [], error: this.errorMessage(error) };
    }
  }

  private isUnexpectedQueueRejection(reason?: string): boolean {
    return Boolean(reason && [
      'FIXTURE_NOT_FOUND',
      'INVALID_KICKOFF_TIME',
      'JOB_STATE_CHANGED_DURING_RECOVERY',
      'JOB_STATE_CHANGED',
      'JOB_STATE_CHANGED_DURING_RECOVERY',
      'NO_REASON_RETURNED',
    ].includes(reason));
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
