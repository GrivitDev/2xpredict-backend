import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { SportsDomainReadService } from '../../sports/services/sports-domain-read.service';
import { SportsDomainCollectionService } from '../../sports/services/sports-domain-collection.service';
import type { SportsMatchReadModel } from '../../sports/interfaces/sports-read.interface';
import { MarketPrediction } from '../../predictions-engine/schemas/market-prediction.schema';
import { PredictionSettlementOutcome } from '../enums/settlement-prediction-outcome.enum';
import { SettlementJobDocument } from '../schemas/settlement-job.schema';
import {
  SettlementRun,
  SettlementRunDocument,
} from '../schemas/settlement-run.schema';
import { SettlementJobStatus } from '../enums/settlement-job-status.enum';
import { SettlementEventLevel } from '../enums/settlement-event-level.enum';
import {
  SettlementProcessResult,
  SettlementTargetCounts,
  SettlementPhase,
} from '../interfaces/settlement-context.interface';
import { FootballMatchFactsService } from './football-match-facts.service';
import { PredictionSettlementService } from './prediction-settlement.service';
import { BetLabSettlementService } from './bet-lab-settlement.service';
import { SettlementEventLogService } from './settlement-event-log.service';
import { SettlementQueueService } from './settlement-queue.service';
import { isSportsFixtureFinished, isSportsFixtureSettleable } from '../utils/fixture-lifecycle.util';
import { SETTLEMENT_CONFIG } from '../config/settlement.config';

@Injectable()
export class SettlementProcessorService {
  private readonly logger = new Logger(SettlementProcessorService.name);

  constructor(
    @InjectModel(SettlementRun.name)
    private readonly runModel: Model<SettlementRunDocument>,
    @InjectModel(MarketPrediction.name)
    private readonly marketPredictionModel: Model<MarketPrediction>,
    private readonly sportsRead: SportsDomainReadService,
    @Inject(forwardRef(() => SportsDomainCollectionService))
    private readonly sportsCollection: SportsDomainCollectionService,
    private readonly factsService: FootballMatchFactsService,
    private readonly predictionSettlementService: PredictionSettlementService,
    private readonly betLabSettlementService: BetLabSettlementService,
    private readonly eventLog: SettlementEventLogService,
    private readonly queue: SettlementQueueService,
  ) {}

  async process(job: SettlementJobDocument): Promise<SettlementProcessResult> {
    await this.queue.assertProcessingLease(job);
    const started = Date.now();
    const eventId = String(job.eventId ?? '').trim();
    if (!eventId) throw new Error('Settlement job does not contain an event ID.');

    // Sports is the sole lifecycle and factual source. This read never calls a
    // provider; fixture, timeline and statistics updates arrive through Sports.
    let match = await this.sportsRead.getMatch(eventId);
    if (!match) throw new Error(`Normalized Sports fixture ${eventId} was not found.`);

    const counts: SettlementTargetCounts = this.emptyCounts();
    const unresolvedReasons: string[] = [];
    if (!isSportsFixtureSettleable(match.fixture)) {
      const reason = `Settlement skipped because Sports fixture state ${match.fixture.status?.state ?? 'UNKNOWN'} is not settleable.`;
      await this.eventLog.write({
        level: SettlementEventLevel.WARN,
        action: 'SETTLEMENT_SKIPPED_NON_SETTLEABLE_SPORTS_STATE',
        message: reason,
        eventId,
        jobKey: job.jobKey,
        metadata: {
          sportsState: match.fixture.status?.state,
          isFinal: match.fixture.status?.isFinal,
          sourceFingerprint: job.sourceFingerprint,
        },
      });
      return {
        eventId,
        sourceFingerprint: job.sourceFingerprint,
        partial: false,
        skipped: true,
        phase: 'IN_PLAY',
        counts,
        unresolvedReasons: [reason],
      };
    }

    const recovered = await this.recoverFinalMatchEvidence(match, job);
    match = recovered.match;
    const facts = recovered.facts;
    const phase: SettlementPhase = isSportsFixtureFinished(match.fixture)
      ? 'FULL_TIME'
      : match.fixture.status.state === 'HALFTIME'
        ? 'HALF_TIME'
        : 'IN_PLAY';

    if (facts.settlementBlockers?.length) {
      unresolvedReasons.push(...facts.settlementBlockers.slice(0, 100));
    }
    if (facts.conflictingStats?.length && unresolvedReasons.length < 100) {
      unresolvedReasons.push(
        `Conflicting normalized Sports statistics require review: ${facts.conflictingStats.slice(0, 20).join(', ')}.`,
      );
    }

    const runFilter = { eventId, sourceFingerprint: facts.sourceFingerprint };
    const run = (await this.runModel
      .findOneAndUpdate(
        runFilter,
        {
          $set: {
            leagueId: facts.leagueId,
            // Retained for compatibility with existing persisted runs/jobs.
            // This field now stores the newest normalized Sports source time.
            sourceSummaryCollectedAt:
              facts.sourceDataCollectedAt ?? job.sourceSummaryCollectedAt,
            status: SettlementJobStatus.PROCESSING,
            counts: counts as unknown as Record<string, number>,
            unresolvedReasons: [],
            startedAt: new Date(),
          },
          $setOnInsert: { eventId, sourceFingerprint: facts.sourceFingerprint },
          $unset: { completedAt: 1 },
        },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
      )
      .exec()) as SettlementRunDocument;

    await this.eventLog.write({
      level: SettlementEventLevel.INFO,
      action: 'SETTLEMENT_PROCESS_STARTED',
      message: `Evaluating ${phase.toLowerCase()} settlement evidence for ${facts.homeTeamName} vs ${facts.awayTeamName}.`,
      eventId,
      jobKey: job.jobKey,
      runId: String(run._id),
      metadata: {
        phase,
        sourceFingerprint: facts.sourceFingerprint,
        sourceDataCollectedAt: facts.sourceDataCollectedAt,
        fixtureSourceCollectedAt: facts.fixtureSourceCollectedAt,
        timelineCollectedAt: facts.timelineCollectedAt,
        statisticsCollectedAt: facts.statisticsCollectedAt,
        homeStatisticsCollectedAt: facts.homeStatisticsCollectedAt,
        awayStatisticsCollectedAt: facts.awayStatisticsCollectedAt,
        fixtureState: facts.fixtureState,
        currentPeriod: facts.currentPeriod,
        currentMinute: facts.currentMinute,
        scoreSource: facts.scoreSource,
        sourceDiagnostics: facts.sourceDiagnostics,
        settlementBlockers: facts.settlementBlockers,
        conflictingStats: facts.conflictingStats,
      },
    });

    try {
      await this.queue.assertProcessingLease(job);
      await this.predictionSettlementService.settleEvent(
        eventId,
        facts,
        counts,
        unresolvedReasons,
      );
      await this.queue.assertProcessingLease(job);
      await this.betLabSettlementService.settleEvent(
        eventId,
        facts,
        job.jobKey,
        counts,
        unresolvedReasons,
      );

      await this.queue.assertProcessingLease(job);
      const partial =
        counts.predictionSelectionsUnresolved > 0 ||
        counts.betLabLegsUnresolved > 0 ||
        (facts.settlementBlockers?.length ?? 0) > 0 ||
        unresolvedReasons.length > 0;
      const completedAt = new Date();
      const durationMs = Date.now() - started;
      const result: SettlementProcessResult = {
        eventId,
        sourceFingerprint: facts.sourceFingerprint,
        partial,
        phase,
        counts,
        unresolvedReasons,
      };

      await this.runModel.updateOne(runFilter, {
        $set: {
          status: partial
            ? SettlementJobStatus.PARTIAL
            : SettlementJobStatus.COMPLETED,
          counts: counts as unknown as Record<string, number>,
          unresolvedReasons: unresolvedReasons.slice(0, 100),
          completedAt,
          durationMs,
        },
      }).exec();

      await this.eventLog.write({
        level: partial ? SettlementEventLevel.WARN : SettlementEventLevel.INFO,
        action: partial
          ? 'SETTLEMENT_PROCESS_PARTIAL'
          : 'SETTLEMENT_PROCESS_COMPLETED',
        message: partial
          ? `Settlement ${phase.toLowerCase()} evaluation completed with unresolved markets or ticket legs for event ${eventId}.`
          : `Settlement ${phase.toLowerCase()} evaluation completed for event ${eventId}.`,
        eventId,
        jobKey: job.jobKey,
        runId: String(run._id),
        metadata: {
          phase,
          ...counts,
          durationMs,
          unresolvedReasonCount: unresolvedReasons.length,
          scoreSource: facts.scoreSource,
          sourceDiagnostics: facts.sourceDiagnostics,
          settlementBlockers: facts.settlementBlockers,
          conflictingStats: facts.conflictingStats,
        },
      });

      this.logger.log(
        `Settlement ${phase}/${partial ? 'PARTIAL' : 'COMPLETED'} for ${eventId}: prediction selections=${counts.predictionSelectionsSettled}, Bet Lab legs=${counts.betLabLegsSettled}, tickets finalized=${counts.betLabTicketsFinalized}, duration=${durationMs}ms`,
      );
      return result;
    } catch (error) {
      const completedAt = new Date();
      const durationMs = Date.now() - started;
      const message = error instanceof Error ? error.message : String(error);
      let stillOwnsLease = false;
      try {
        stillOwnsLease = await this.queue.ownsProcessingLease(job);
      } catch (leaseCheckError) {
        this.logger.warn(
          `Could not verify Settlement lease while handling ${eventId}: ${leaseCheckError instanceof Error ? leaseCheckError.message : String(leaseCheckError)}`,
        );
      }
      if (stillOwnsLease) {
        try {
          await this.runModel.updateOne(runFilter, {
            $set: {
              status: SettlementJobStatus.FAILED,
              counts: counts as unknown as Record<string, number>,
              unresolvedReasons: [...unresolvedReasons, `PROCESSING_ERROR: ${message}`].slice(0, 100),
              completedAt,
              durationMs,
            },
          }).exec();
        } catch (runUpdateError) {
          this.logger.error(
            `Could not mark settlement run failed for ${eventId}: ${runUpdateError instanceof Error ? runUpdateError.message : String(runUpdateError)}`,
          );
        }
        try {
          await this.eventLog.write({
            level: SettlementEventLevel.ERROR,
            action: 'SETTLEMENT_PROCESS_FAILED',
            message: `Settlement processing failed for event ${eventId}: ${message}`,
            eventId,
            jobKey: job.jobKey,
            runId: String(run._id),
            metadata: { ...counts, durationMs, error: message },
          });
        } catch (loggingError) {
          this.logger.warn(
            `Could not persist Settlement process failure event for ${eventId}: ${loggingError instanceof Error ? loggingError.message : String(loggingError)}`,
          );
        }
      } else {
        this.logger.warn(
          `Settlement processor stopped updating run ${eventId} because its queue lease is no longer owned by this worker.`,
        );
      }
      throw error;
    }
  }

  /**
   * Optional, one-time historical repair of terminal Prediction selections.
   * It is explicitly feature-flagged and only re-grades matches that Sports
   * currently confirms FULL_TIME. Live/in-play outcomes are never cleared or
   * rewritten by this historical pass. Bet Lab terminal tickets remain excluded
   * because changing them requires a separately audited wallet-ledger correction.
   */
  async runHistoricalResettlementOnce(): Promise<Record<string, unknown>> {
    if (String(process.env.SETTLEMENT_HISTORICAL_RESETTLE_ON_STARTUP ?? '').toLowerCase() !== 'true') {
      return { enabled: false, skipped: true, reason: 'FEATURE_FLAG_DISABLED' };
    }

    const markerEventId = '__SYSTEM_HISTORICAL_RESETTLE_SPORTS_V2__';
    const markerFingerprint = 'HISTORICAL_RESETTLE_SPORTS_V2';
    const markerFilter = { eventId: markerEventId, sourceFingerprint: markerFingerprint };
    const emptyCounts = (): SettlementTargetCounts => this.emptyCounts();

    try {
      await this.runModel.findOneAndUpdate(
        markerFilter,
        {
          $setOnInsert: {
            ...markerFilter,
            leagueId: 'system',
            sourceSummaryCollectedAt: new Date(),
            status: SettlementJobStatus.QUEUED,
            counts: emptyCounts() as unknown as Record<string, number>,
            unresolvedReasons: [],
          },
        },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
      ).exec();
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 11000)) {
        throw error;
      }
    }

    const existing = await this.runModel.findOne(markerFilter).lean().exec() as any;
    if (existing && [SettlementJobStatus.COMPLETED, SettlementJobStatus.PARTIAL].includes(existing.status)) {
      return { enabled: true, skipped: true, reason: 'ALREADY_COMPLETED', status: existing.status, counts: existing.counts };
    }

    const staleBefore = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const claimed = await this.runModel.findOneAndUpdate(
      {
        ...markerFilter,
        $or: [
          { status: { $in: [SettlementJobStatus.QUEUED, SettlementJobStatus.RETRY, SettlementJobStatus.FAILED, SettlementJobStatus.SKIPPED] } },
          { status: SettlementJobStatus.PROCESSING, startedAt: { $lt: staleBefore } },
          { status: SettlementJobStatus.PROCESSING, startedAt: { $exists: false } },
        ],
      },
      {
        $set: {
          status: SettlementJobStatus.PROCESSING,
          startedAt: new Date(),
          leagueId: 'system',
          sourceSummaryCollectedAt: new Date(),
          counts: emptyCounts() as unknown as Record<string, number>,
          unresolvedReasons: [],
        },
        $unset: { completedAt: 1 },
      },
      { returnDocument: 'after' },
    ).exec();

    if (!claimed) {
      const current = await this.runModel.findOne(markerFilter).lean().exec() as any;
      return { enabled: true, skipped: true, reason: 'ALREADY_RUNNING_OR_COMPLETED', status: current?.status };
    }

    const startedAt = Date.now();
    const counts = emptyCounts();
    const unresolvedReasons: string[] = [];
    let processedEvents = 0;
    let updatedEvents = 0;
    let unresolvedEvents = 0;

    try {
      const terminalOutcomes = Object.values(PredictionSettlementOutcome);
      const rawEventIds = await this.marketPredictionModel.distinct('eventId', {
        'selections.actualOutcome': { $in: terminalOutcomes },
      }).exec();
      const eventIds = [...new Set(rawEventIds.map((value) => String(value ?? '').trim()).filter(Boolean))];
      await this.eventLog.write({
        level: SettlementEventLevel.WARN,
        action: 'SETTLEMENT_HISTORICAL_RESETTLE_STARTED',
        message: `Sports-native historical resettlement started for ${eventIds.length} previously settled Prediction events.`,
        runId: String(claimed._id),
        metadata: { markerFingerprint, totalEvents: eventIds.length },
      });

      const batchSize = 25;
      for (let offset = 0; offset < eventIds.length; offset += batchSize) {
        const batch = eventIds.slice(offset, offset + batchSize);
        for (const eventId of batch) {
          const match = await this.sportsRead.getMatch(eventId);
          if (!match || !isSportsFixtureFinished(match.fixture)) {
            unresolvedEvents += 1;
            if (unresolvedReasons.length < 100) {
              unresolvedReasons.push(`${eventId}: Sports does not currently confirm a finished fixture; historical outcomes were preserved unchanged.`);
            }
            processedEvents += 1;
            continue;
          }

          let timelineCoverageComplete = false;
          try {
            timelineCoverageComplete = await this.sportsCollection.hasCompleteMatchPlays(match.fixture.id);
          } catch (error) {
            this.logger.warn(
              `Could not verify historical Core Plays coverage for ${eventId}: ${this.errorMessage(error)}`,
            );
          }
          const facts = this.factsService.extract(match, { timelineCoverageComplete });
          const beforeSettled = counts.predictionSelectionsSettled;
          const beforeUnresolved = counts.predictionSelectionsUnresolved;
          const eventReasons: string[] = [];
          await this.predictionSettlementService.settleEvent(
            eventId,
            facts,
            counts,
            eventReasons,
            { resettleSettled: true, auditLabel: markerFingerprint },
          );
          if (
            counts.predictionSelectionsSettled > beforeSettled ||
            counts.predictionSelectionsUnresolved > beforeUnresolved
          ) updatedEvents += 1;

          const integrityReasons = [
            ...(facts.settlementBlockers ?? []),
            ...(facts.conflictingStats?.length
              ? [`Conflicting normalized Sports statistics require review: ${facts.conflictingStats.slice(0, 20).join(', ')}.`]
              : []),
            ...eventReasons,
          ];
          if (integrityReasons.length > 0) {
            unresolvedEvents += 1;
            for (const reason of integrityReasons) {
              if (unresolvedReasons.length < 100 && !unresolvedReasons.includes(`${eventId}: ${reason}`)) {
                unresolvedReasons.push(`${eventId}: ${reason}`);
              }
            }
          }
          processedEvents += 1;
        }

        await this.runModel.updateOne(markerFilter, {
          $set: {
            counts: {
              ...(counts as unknown as Record<string, number>),
              historicalTotalEvents: eventIds.length,
              historicalProcessedEvents: processedEvents,
              historicalUpdatedEvents: updatedEvents,
              historicalUnresolvedEvents: unresolvedEvents,
            },
            unresolvedReasons: unresolvedReasons.slice(0, 100),
          },
        }).exec();
      }

      const durationMs = Date.now() - startedAt;
      const partial = unresolvedEvents > 0 || counts.predictionSelectionsUnresolved > 0;
      const finalStatus = partial ? SettlementJobStatus.PARTIAL : SettlementJobStatus.COMPLETED;
      await this.runModel.updateOne(markerFilter, {
        $set: {
          status: finalStatus,
          counts: {
            ...(counts as unknown as Record<string, number>),
            historicalTotalEvents: eventIds.length,
            historicalProcessedEvents: processedEvents,
            historicalUpdatedEvents: updatedEvents,
            historicalUnresolvedEvents: unresolvedEvents,
            durationMs,
          },
          unresolvedReasons: unresolvedReasons.slice(0, 100),
          completedAt: new Date(),
          durationMs,
        },
      }).exec();
      await this.eventLog.write({
        level: partial ? SettlementEventLevel.WARN : SettlementEventLevel.INFO,
        action: 'SETTLEMENT_HISTORICAL_RESETTLE_COMPLETED',
        message: `Sports-native historical resettlement ${partial ? 'finished partially' : 'completed'}: processed ${processedEvents}/${eventIds.length}; updated ${updatedEvents}; unresolved ${unresolvedEvents}.`,
        runId: String(claimed._id),
        metadata: { markerFingerprint, totalEvents: eventIds.length, processedEvents, updatedEvents, unresolvedEvents, counts, durationMs, betLabTerminalTicketsChanged: 0 },
      });
      return { enabled: true, skipped: false, status: finalStatus, totalEvents: eventIds.length, processedEvents, updatedEvents, unresolvedEvents, counts, durationMs };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.runModel.updateOne(markerFilter, {
        $set: {
          status: SettlementJobStatus.FAILED,
          counts: counts as unknown as Record<string, number>,
          unresolvedReasons: [...unresolvedReasons, `HISTORICAL_RESETTLE_FAILED: ${message}`].slice(0, 100),
          completedAt: new Date(),
          durationMs: Date.now() - startedAt,
        },
      }).exec();
      await this.eventLog.write({
        level: SettlementEventLevel.ERROR,
        action: 'SETTLEMENT_HISTORICAL_RESETTLE_FAILED',
        message: `Sports-native historical resettlement failed: ${message}`,
        runId: String(claimed._id),
        metadata: { processedEvents, updatedEvents, unresolvedEvents },
      });
      throw error;
    }
  }

  /**
   * Finished-match evidence is recovered through the existing Sports
   * collection boundary. A Summary refresh is attempted only when the final
   * score/statistics snapshot is missing or stale; Core Plays is requested
   * when complete timeline coverage has not yet been confirmed.
   *
   * Provider failures are fail-safe: the current normalized Sports facts are
   * still evaluated, and any market requiring missing evidence remains
   * UNRESOLVED for the queue's normal partial retry.
   */
  private async recoverFinalMatchEvidence(
    initialMatch: SportsMatchReadModel,
    job: SettlementJobDocument,
  ): Promise<{ match: SportsMatchReadModel; facts: ReturnType<FootballMatchFactsService['extract']> }> {
    let match = initialMatch;
    let fixture = match.fixture;

    // Stage 9: first re-normalize the latest retained raw ESPN Summary locally.
    // This avoids another ESPN call when raw Summary exists but normalized facts
    // are missing or were produced by an older normalization version.
    const summaryMetadata = match.matchSummary;
    const normalizedFacts = match.matchFacts;
    const summaryNeedsNormalization = Boolean(
      summaryMetadata && (
        !normalizedFacts ||
        normalizedFacts.sourcePayloadHash !== summaryMetadata.payloadHash ||
        normalizedFacts.sourceRevision !== summaryMetadata.revision ||
        normalizedFacts.normalizationVersion !== '1.1.0'
      ),
    );
    if (isSportsFixtureFinished(fixture) && summaryNeedsNormalization) {
      try {
        await this.sportsCollection.normalizeStoredMatchSummary(fixture);
        await this.queue.assertProcessingLease(job);
        const normalizedMatch = await this.sportsRead.getMatch(fixture.id);
        if (normalizedMatch) {
          match = normalizedMatch;
          fixture = normalizedMatch.fixture;
        }
      } catch (error) {
        this.logger.warn(
          `Retained ESPN Summary normalization failed for ${fixture.id}; settlement will use the verified facts already available: ${this.errorMessage(error)}`,
        );
      }
    }
    if (!isSportsFixtureFinished(fixture)) {
      return {
        match,
        facts: this.factsService.extract(match, { timelineCoverageComplete: false }),
      };
    }

    let timelineCoverageComplete = false;
    try {
      timelineCoverageComplete = await this.sportsCollection.hasCompleteMatchPlays(fixture.id);
    } catch (error) {
      this.logger.warn(
        `Could not verify Core Plays coverage for ${fixture.id}: ${this.errorMessage(error)}`,
      );
    }

    let facts = this.factsService.extract(match, { timelineCoverageComplete });
    let sportsDataRefreshed = false;
    const statisticsFreshnessMs = SETTLEMENT_CONFIG.evidence.fullTimeStatisticsFreshnessMs;
    const needsSummary =
      facts.scoreSource !== 'ESPN_SUMMARY' ||
      !this.hasFreshTeamStatistics(facts, statisticsFreshnessMs) ||
      Object.keys(facts.homeStats).length === 0 ||
      Object.keys(facts.awayStats).length === 0 ||
      facts.homeGoals === undefined ||
      facts.awayGoals === undefined ||
      (facts.afterExtraTime === true && facts.regulationScoreAvailable !== true);

    if (needsSummary && match.competition?.slug && fixture.espnEventId) {
      try {
        const shouldCollect = await this.sportsCollection.shouldCollectFixtureSummary(
          fixture.espnEventId,
          statisticsFreshnessMs,
        );
        if (shouldCollect) {
          await this.queue.assertProcessingLease(job);
          const summaryFixture = await this.sportsCollection.collectFixtureSummary(
            match.competition.slug,
            fixture.espnEventId,
            {
              competitionId: fixture.competitionId,
              seasonId: fixture.seasonId,
              seasonYear: fixture.seasonYear,
            },
          );
          // collectFixtureSummary persists the raw response and normalized facts
          // independently of whether its fixture normalizer returns a fixture.
          sportsDataRefreshed = true;
          this.logger.log(`Requested ESPN Summary recovery for finished Sports fixture ${fixture.id}${summaryFixture ? '' : ' (raw Summary retained; fixture normalization incomplete)'}.`);
        }
      } catch (error) {
        this.logger.warn(
          `ESPN Summary recovery failed for finished Sports fixture ${fixture.id}; settlement will retain unresolved evidence: ${this.errorMessage(error)}`,
        );
      }
    }

    if (!timelineCoverageComplete) {
      try {
        const shouldCollect = await this.sportsCollection.shouldCollectMatchPlays(fixture.id);
        if (shouldCollect) {
          await this.queue.assertProcessingLease(job);
          const playsResult = await this.sportsCollection.collectMatchPlays(fixture);
          if (playsResult) {
            sportsDataRefreshed = true;
            this.logger.log(`Requested Core Plays recovery for finished Sports fixture ${fixture.id}.`);
          }
        }
      } catch (error) {
        this.logger.warn(
          `Core Plays recovery failed for finished Sports fixture ${fixture.id}; event markets will remain unresolved where coverage is required: ${this.errorMessage(error)}`,
        );
      }
    }

    if (sportsDataRefreshed) {
      await this.queue.assertProcessingLease(job);
      const refreshedMatch = await this.sportsRead.getMatch(fixture.id);
      if (refreshedMatch) match = refreshedMatch;
      try {
        timelineCoverageComplete = await this.sportsCollection.hasCompleteMatchPlays(match.fixture.id);
      } catch (error) {
        timelineCoverageComplete = false;
        this.logger.warn(
          `Could not verify refreshed Core Plays coverage for ${fixture.id}: ${this.errorMessage(error)}`,
        );
      }
    }

    facts = this.factsService.extract(match, { timelineCoverageComplete });
    return { match, facts };
  }

  private hasFreshTeamStatistics(
    facts: ReturnType<FootballMatchFactsService['extract']>,
    maximumAgeMs: number,
  ): boolean {
    const now = Date.now();
    return [facts.homeStatisticsCollectedAt, facts.awayStatisticsCollectedAt].every((value) => {
      if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return false;
      const age = now - value.getTime();
      return age >= -60_000 && age <= maximumAgeMs;
    });
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private emptyCounts(): SettlementTargetCounts {
    return {
      predictionMarketsFound: 0,
      predictionSelectionsSettled: 0,
      predictionSelectionsSkipped: 0,
      predictionSelectionsUnresolved: 0,
      betLabTicketsFound: 0,
      betLabLegsSettled: 0,
      betLabTicketsFinalized: 0,
      betLabLegsUnresolved: 0,
    };
  }
}


