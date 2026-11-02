import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EspnFixture } from '../../sports/schemas/espn/espn-fixture.schema';
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
} from '../interfaces/settlement-context.interface';
import { FootballMatchFactsService } from './football-match-facts.service';
import { PredictionSettlementService } from './prediction-settlement.service';
import { BetLabSettlementService } from './bet-lab-settlement.service';
import { SettlementEventLogService } from './settlement-event-log.service';
import { EspnService } from '../../sports/providers/espn.service';
import { SportsCollectionService } from '../../sports/services/sports-collection.service';
import { SETTLEMENT_CONFIG } from '../config/settlement.config';

@Injectable()
export class SettlementProcessorService {
  private readonly logger = new Logger(SettlementProcessorService.name);
  constructor(
    @InjectModel(EspnFixture.name)
    private readonly fixtureModel: Model<EspnFixture>,
    @InjectModel(SettlementRun.name)
    private readonly runModel: Model<SettlementRunDocument>,
    @InjectModel(MarketPrediction.name)
    private readonly marketPredictionModel: Model<MarketPrediction>,
    private readonly factsService: FootballMatchFactsService,
    private readonly predictionSettlementService: PredictionSettlementService,
    private readonly betLabSettlementService: BetLabSettlementService,
    private readonly eventLog: SettlementEventLogService,
    private readonly espnService: EspnService,
    @Inject(forwardRef(() => SportsCollectionService))
    private readonly sportsCollectionService: SportsCollectionService,
  ) {}

  async process(job: SettlementJobDocument): Promise<SettlementProcessResult> {
    const started = Date.now();
    const eventId = String(job.eventId);
    const fixture = (await this.fixtureModel
      .findOne({ eventId })
      .lean()
      .exec()) as unknown as EspnFixture | null;
    if (!fixture)
      throw new Error(`Settlement fixture ${eventId} was not found.`);
    // Settlement queue eligibility begins at kickoff +180 minutes, so the recovery scan has the fixture queued by +190 minutes. If the canonical
    // fixture lacks settlement evidence, Settlement performs its own targeted
    // ESPN Summary call before processing. ESPN failures never block settlement
    // of facts already stored locally.
    let currentFixture = fixture;
    let facts = this.factsService.extract(currentFixture);
    let summaryRequestedThisRun = false;
    if (this.needsSummaryData(currentFixture, facts)) {
      summaryRequestedThisRun = await this.refreshSummaryForSettlement(currentFixture, eventId);
      if (summaryRequestedThisRun) {
        const refreshedFixture = await this.fixtureModel.findOne({ eventId }).lean().exec();
        if (refreshedFixture) {
          currentFixture = refreshedFixture as unknown as EspnFixture;
          facts = this.factsService.extract(currentFixture);
        }
      }
    }
    const counts: SettlementTargetCounts = {
      predictionMarketsFound: 0,
      predictionSelectionsSettled: 0,
      predictionSelectionsSkipped: 0,
      predictionSelectionsUnresolved: 0,
      betLabTicketsFound: 0,
      betLabLegsSettled: 0,
      betLabTicketsFinalized: 0,
      betLabLegsUnresolved: 0,
    };
    const unresolvedReasons: string[] = [];
    if (facts.settlementBlockers?.length) {
      unresolvedReasons.push(...facts.settlementBlockers.slice(0, 100));
    }
    if (facts.conflictingStats?.length && unresolvedReasons.length < 100) {
      unresolvedReasons.push(`Conflicting provider statistics require review: ${facts.conflictingStats.slice(0, 20).join(', ')}.`);
    }
    const runFilter = { eventId, sourceFingerprint: facts.sourceFingerprint };
    const run = (await this.runModel
      .findOneAndUpdate(
        runFilter,
        {
          $set: {
            leagueId: facts.leagueId,
            sourceSummaryCollectedAt:
              facts.sourceSummaryCollectedAt ?? job.sourceSummaryCollectedAt,
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
      message: `Processing available fixture facts for ${facts.homeTeamName} vs ${facts.awayTeamName}.`,
      eventId,
      jobKey: job.jobKey,
      runId: String(run._id),
      metadata: {
        sourceFingerprint: facts.sourceFingerprint,
        summaryCollectedAt: facts.sourceSummaryCollectedAt,
        scoreSource: facts.scoreSource,
        sourceDiagnostics: facts.sourceDiagnostics,
        settlementBlockers: facts.settlementBlockers,
        conflictingStats: facts.conflictingStats,
      },
    });

    try {
      await this.predictionSettlementService.settleEvent(
        eventId,
        facts,
        counts,
        unresolvedReasons,
      );
      await this.betLabSettlementService.settleEvent(
        eventId,
        facts,
        job.jobKey,
        counts,
        unresolvedReasons,
      );

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
        counts,
        unresolvedReasons,
      };
      await this.runModel
        .updateOne(runFilter, {
          $set: {
            status: partial
              ? SettlementJobStatus.PARTIAL
              : SettlementJobStatus.COMPLETED,
            counts: counts as unknown as Record<string, number>,
            unresolvedReasons: unresolvedReasons.slice(0, 100),
            completedAt,
            durationMs,
          },
        })
        .exec();
      await this.eventLog.write({
        level: partial ? SettlementEventLevel.WARN : SettlementEventLevel.INFO,
        action: partial
          ? 'SETTLEMENT_PROCESS_PARTIAL'
          : 'SETTLEMENT_PROCESS_COMPLETED',
        message: partial
          ? `Settlement completed with unresolved markets or ticket legs for event ${eventId}.`
          : `Settlement completed for event ${eventId}.`,
        eventId,
        jobKey: job.jobKey,
        runId: String(run._id),
        metadata: {
          ...counts,
          durationMs,
          unresolvedReasonCount: unresolvedReasons.length,
          scoreSource: facts.scoreSource,
          sourceDiagnostics: facts.sourceDiagnostics,
          settlementBlockers: facts.settlementBlockers,
          conflictingStats: facts.conflictingStats,
        },
      });
      if (partial && unresolvedReasons.length > 0 && !summaryRequestedThisRun) {
        // A partial first pass can reveal that market-specific evidence is absent
        // even when a basic score was present. Make one targeted provider call;
        // the persisted cooldown prevents retry loops across re-evaluations.
        await this.refreshSummaryForSettlement(currentFixture, eventId);
      }

      this.logger.log(
        `Settlement ${partial ? 'PARTIAL' : 'COMPLETED'} for ${eventId}: prediction selections=${counts.predictionSelectionsSettled}, Bet Lab legs=${counts.betLabLegsSettled}, tickets finalized=${counts.betLabTicketsFinalized}, duration=${durationMs}ms`,
      );
      return result;
    } catch (error) {
      const completedAt = new Date();
      const durationMs = Date.now() - started;
      const message = error instanceof Error ? error.message : String(error);
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
        this.logger.error(`Could not mark settlement run failed for ${eventId}: ${runUpdateError instanceof Error ? runUpdateError.message : String(runUpdateError)}`);
      }
      await this.eventLog.write({
        level: SettlementEventLevel.ERROR,
        action: 'SETTLEMENT_PROCESS_FAILED',
        message: `Settlement processing failed for event ${eventId}: ${message}`,
        eventId,
        jobKey: job.jobKey,
        runId: String(run._id),
        metadata: { ...counts, durationMs, error: message },
      });
      throw error;
    }
  }

  /**
   * TEMPORARY ONE-TIME REPAIR: recompute previously settled Prediction Engine
   * selections using the corrected fact extraction and Odds catalogue.
   * Enabled only by SETTLEMENT_HISTORICAL_RESETTLE_ON_STARTUP=true and guarded
   * by a durable marker in settlement_runs so a restart cannot credit/rewrite
   * the same pass repeatedly. Terminal Bet Lab tickets are deliberately excluded:
   * changing those requires a separate audited wallet-ledger correction, not a
   * second ordinary settlement credit.
   */
  async runHistoricalResettlementOnce(): Promise<Record<string, unknown>> {
    if (String(process.env.SETTLEMENT_HISTORICAL_RESETTLE_ON_STARTUP ?? '').toLowerCase() !== 'true') {
      return { enabled: false, skipped: true, reason: 'FEATURE_FLAG_DISABLED' };
    }

    const markerEventId = '__SYSTEM_HISTORICAL_RESETTLE_V1__';
    const markerFingerprint = 'HISTORICAL_RESETTLE_V1';
    const markerFilter = { eventId: markerEventId, sourceFingerprint: markerFingerprint };
    const emptyCounts = (): SettlementTargetCounts => ({
      predictionMarketsFound: 0,
      predictionSelectionsSettled: 0,
      predictionSelectionsSkipped: 0,
      predictionSelectionsUnresolved: 0,
      betLabTicketsFound: 0,
      betLabLegsSettled: 0,
      betLabTicketsFinalized: 0,
      betLabLegsUnresolved: 0,
    });

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
      // Concurrent app instances may race to create the unique marker. Re-read
      // it below; only duplicate-key races are expected here.
      if (!(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 11000)) {
        throw error;
      }
    }

    const existing = await this.runModel.findOne(markerFilter).lean().exec() as any;
    if (existing && [SettlementJobStatus.COMPLETED, SettlementJobStatus.PARTIAL].includes(existing.status)) {
      this.logger.log(`Historical resettlement already completed; skipping. status=${existing.status}`);
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
      const totalEvents = eventIds.length;
      this.logger.warn(`One-time historical resettlement started for ${totalEvents} Prediction Engine events. This may take time.`);
      await this.eventLog.write({
        level: SettlementEventLevel.WARN,
        action: 'SETTLEMENT_HISTORICAL_RESETTLE_STARTED',
        message: `One-time historical resettlement started for ${totalEvents} Prediction Engine events.`,
        runId: String(claimed._id),
        metadata: { markerFingerprint, totalEvents },
      });

      const batchSize = 50;
      for (let offset = 0; offset < eventIds.length; offset += batchSize) {
        const batch = eventIds.slice(offset, offset + batchSize);
        const fixtureValues = await this.fixtureModel.find({ eventId: { $in: batch } }).lean().exec();
        const fixtureById = new Map<string, unknown>();
        for (const value of fixtureValues as unknown as Array<Record<string, unknown>>) {
          fixtureById.set(String(value.eventId ?? ''), value);
        }

        for (const eventId of batch) {
          const fixtureValue = fixtureById.get(eventId);
          if (!fixtureValue) {
            unresolvedEvents += 1;
            if (unresolvedReasons.length < 100) unresolvedReasons.push(`${eventId}: canonical fixture was not found; previous outcomes were retained.`);
            processedEvents += 1;
            continue;
          }

          let currentFixture = fixtureValue;
          let facts = this.factsService.extract(currentFixture);
          // This pass may cover thousands of old fixtures. Do not trigger a
          // provider request merely because every stat/event detail is not
          // available; use stored Summary data consistently and refresh only
          // where the fixture/result payload itself is absent or incomplete.
          if (this.historicalNeedsSummaryRefresh(currentFixture, facts)) {
            const requested = await this.refreshSummaryForSettlement(currentFixture, eventId);
            if (requested) {
              const refreshed = await this.fixtureModel.findOne({ eventId }).lean().exec();
              if (refreshed) {
                currentFixture = refreshed;
                facts = this.factsService.extract(currentFixture);
              }
            }
          }

          const beforeSettled = counts.predictionSelectionsSettled;
          const beforeUnresolved = counts.predictionSelectionsUnresolved;
          const eventReasons: string[] = [];
          if (!facts.isFinished) {
            // Let the corrected settlement service move terminal outcomes to
            // pending review rather than silently preserving an unverified result.
            eventReasons.push('Fixture is not confirmed finished by the current ESPN status; previous terminal outcomes require review.');
          }
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
          if (
            eventReasons.length > 0 ||
            (facts.settlementBlockers?.length ?? 0) > 0 ||
            (facts.conflictingStats?.length ?? 0) > 0
          ) {
            unresolvedEvents += 1;
            const integrityReasons = [
              ...facts.settlementBlockers,
              ...(facts.conflictingStats?.length
                ? [`Conflicting provider statistics require review: ${facts.conflictingStats.slice(0, 20).join(', ')}.`]
                : []),
              ...eventReasons,
            ];
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
              historicalTotalEvents: totalEvents,
              historicalProcessedEvents: processedEvents,
              historicalUpdatedEvents: updatedEvents,
              historicalUnresolvedEvents: unresolvedEvents,
            },
            unresolvedReasons: unresolvedReasons.slice(0, 100),
          },
        }).exec();
        this.logger.log(`Historical resettlement progress: ${processedEvents}/${totalEvents}; updated events=${updatedEvents}; unresolved=${unresolvedEvents}.`);
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
        message: `Historical resettlement ${partial ? 'finished partially' : 'completed'}: processed ${processedEvents}/${eventIds.length} events; updated ${updatedEvents}; unresolved ${unresolvedEvents}.`,
        runId: String(claimed._id),
        metadata: {
          markerFingerprint,
          totalEvents: eventIds.length,
          processedEvents,
          updatedEvents,
          unresolvedEvents,
          counts,
          durationMs,
          betLabTerminalTicketsChanged: 0,
        },
      });
      return {
        enabled: true,
        skipped: false,
        status: finalStatus,
        totalEvents: eventIds.length,
        processedEvents,
        updatedEvents,
        unresolvedEvents,
        counts,
        durationMs,
      };
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
        message: `Historical resettlement failed: ${message}`,
        runId: String(claimed._id),
        metadata: { processedEvents, updatedEvents, unresolvedEvents },
      });
      throw error;
    }
  }

  private historicalNeedsSummaryRefresh(
    fixture: unknown,
    facts: ReturnType<FootballMatchFactsService['extract']>,
  ): boolean {
    const raw = fixture && typeof fixture === 'object'
      ? fixture as Record<string, unknown>
      : {};
    const payload = raw.payload && typeof raw.payload === 'object' && !Array.isArray(raw.payload)
      ? raw.payload as Record<string, unknown>
      : {};
    const summary = payload.summary && typeof payload.summary === 'object' && !Array.isArray(payload.summary)
      ? payload.summary as Record<string, unknown>
      : {};
    return Object.keys(summary).length === 0 ||
      facts.homeGoals === undefined || facts.awayGoals === undefined ||
      !facts.homeTeamId || !facts.awayTeamId ||
      !facts.isFinished ||
      (facts.settlementBlockers ?? []).some((reason) =>
        /score conflict|persisted root fixture score|partial summary header/i.test(reason),
      );
  }

  private needsSummaryData(fixture: unknown, facts: ReturnType<FootballMatchFactsService['extract']>): boolean {
    const raw = fixture && typeof fixture === 'object' ? fixture as Record<string, unknown> : {};
    const payload = raw.payload && typeof raw.payload === 'object' && !Array.isArray(raw.payload)
      ? raw.payload as Record<string, unknown>
      : {};
    const summary = payload.summary && typeof payload.summary === 'object' && !Array.isArray(payload.summary)
      ? payload.summary as Record<string, unknown>
      : {};
    return Object.keys(summary).length === 0 ||
      !facts.isFinished ||
      facts.homeGoals === undefined || facts.awayGoals === undefined ||
      !facts.goalEventsComplete ||
      !facts.eventDetailsAvailable ||
      (facts.settlementBlockers?.length ?? 0) > 0 ||
      (facts.conflictingStats?.length ?? 0) > 0 ||
      Object.keys(facts.homeStats ?? {}).length === 0 ||
      Object.keys(facts.awayStats ?? {}).length === 0;
  }

  private async refreshSummaryForSettlement(fixtureValue: unknown, eventId: string): Promise<boolean> {
    const fixture = fixtureValue && typeof fixtureValue === 'object'
      ? fixtureValue as Record<string, unknown>
      : {};
    const leagueId = String(fixture.leagueId ?? '').trim().toLowerCase();
    const payload = fixture.payload && typeof fixture.payload === 'object' && !Array.isArray(fixture.payload)
      ? fixture.payload as Record<string, unknown>
      : {};
    if (!leagueId || !eventId) return false;

    const lastAttemptValue = payload.settlementSummaryAttemptedAt;
    const lastAttempt = lastAttemptValue instanceof Date
      ? lastAttemptValue
      : lastAttemptValue ? new Date(lastAttemptValue as string | number) : undefined;
    if (lastAttempt && Number.isFinite(lastAttempt.getTime()) &&
      Date.now() - lastAttempt.getTime() < SETTLEMENT_CONFIG.queue.summaryRequestCooldownMs) {
      return false;
    }

    // Claim the refresh cooldown atomically. Multiple backend replicas can
    // process different jobs for the same fixture; a read-then-write cooldown
    // would allow all of them to call ESPN at once.
    const cooldownCutoff = new Date(Date.now() - SETTLEMENT_CONFIG.queue.summaryRequestCooldownMs);
    let refreshClaimed = false;
    try {
      const claim = await this.fixtureModel.findOneAndUpdate(
        {
          eventId,
          $or: [
            { 'payload.settlementSummaryAttemptedAt': { $exists: false } },
            { 'payload.settlementSummaryAttemptedAt': null },
            { 'payload.settlementSummaryAttemptedAt': { $lte: cooldownCutoff } },
          ],
        },
        { $set: { 'payload.settlementSummaryAttemptedAt': new Date() } },
        { returnDocument: 'before' },
      ).select({ eventId: 1 }).lean().exec();
      refreshClaimed = Boolean(claim);
    } catch (error) {
      // Fail closed on the provider call when the distributed cooldown cannot
      // be claimed. The settlement job remains recoverable and will try again.
      this.logger.warn(`Could not claim Settlement Summary cooldown for ${eventId}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }

    if (!refreshClaimed) {
      this.logger.debug(`Settlement Summary refresh skipped for ${eventId}: another attempt is inside the cooldown window.`);
      return false;
    }

    try {
      const summary = await this.espnService.getMatchSummary(leagueId, eventId);
      if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
        this.logger.warn(`Settlement received no usable ESPN Summary for ${eventId}.`);
        return true;
      }
      await this.sportsCollectionService.collectEspnMatchSummary({ leagueId, eventId, summary });
      this.logger.log(`Settlement refreshed ESPN Summary directly for ${eventId}.`);
      return true;
    } catch (error) {
      this.logger.warn(
        `Settlement's direct ESPN Summary call failed for ${eventId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return true;
    }
  }

}
