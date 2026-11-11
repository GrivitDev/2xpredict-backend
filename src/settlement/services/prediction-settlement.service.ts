import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { MarketPrediction } from '../../predictions-engine/schemas/market-prediction.schema';
import { PredictionSlip } from '../../predictions-engine/schemas/prediction-slip.schema';
import { CuratedPrediction } from '../../predictions-engine/schemas/curated-prediction.schema';
import { PredictionStatus } from '../../predictions-engine/enums/prediction-status.enum';
import {
  SettlementEventFacts,
  SettlementTargetCounts,
  SettlementPhase,
} from '../interfaces/settlement-context.interface';
import { SettlementOutcome } from '../enums/settlement-outcome.enum';
import { PredictionSettlementOutcome } from '../enums/settlement-prediction-outcome.enum';
import { SettlementEventLogService } from './settlement-event-log.service';
import { SettlementEventLevel } from '../enums/settlement-event-level.enum';
import { MarketSettlementService } from './market-settlement.service';

type SettlementSelection = {
  actualOutcome?: unknown;
  status?: unknown;
  key?: unknown;
  fullName?: unknown;
  settledAt?: Date;
  settlementMethod?: string;
  settlementReason?: string;
  settlementEvidence?: unknown;
  settlementSourceFingerprint?: string;
  settlementPhase?: SettlementPhase;
  diagnostics?: unknown;
  settlementHistory?: Array<Record<string, unknown>>;
};

const PERSISTED_OUTCOMES = new Set<string>(Object.values(PredictionSettlementOutcome));

type SettlementProjection = {
  outcome: string;
  phase?: SettlementPhase;
  sourceFingerprint?: string;
  method?: string;
  reason?: string;
  settledAt?: Date;
  sourceRecheck: boolean;
};

@Injectable()
export class PredictionSettlementService {
  constructor(
    @InjectModel(MarketPrediction.name)
    private readonly marketPredictionModel: Model<MarketPrediction>,
    @InjectModel(PredictionSlip.name)
    private readonly predictionSlipModel: Model<PredictionSlip>,
    @InjectModel(CuratedPrediction.name)
    private readonly curatedPredictionModel: Model<CuratedPrediction>,
    private readonly marketSettlementService: MarketSettlementService,
    private readonly eventLog: SettlementEventLogService,
  ) {}

  async settleEvent(
    eventId: string,
    facts: SettlementEventFacts,
    counts: SettlementTargetCounts,
    unresolvedReasons: string[],
    options: { resettleSettled?: boolean; auditLabel?: string } = {},
  ): Promise<void> {
    const markets = await this.marketPredictionModel.find({ eventId }).exec();
    counts.predictionMarketsFound += markets.length;
    const settledAt = new Date();

    for (const market of markets) {
      const marketKey = String(market.marketKey ?? '');
      const selections: SettlementSelection[] = Array.isArray(market.selections)
        ? market.selections
        : [];
      for (let selectionIndex = 0; selectionIndex < selections.length; selectionIndex += 1) {
        const selection = selections[selectionIndex];
        if (!selection) continue;
        const existingOutcome = String(selection.actualOutcome ?? '').toUpperCase();
        const wasPreviouslySettled = PERSISTED_OUTCOMES.has(existingOutcome);
        // Non-full-time outcomes remain provisional until the fixture reaches
        // full time. A changed Sports fingerprint reopens them for correction.
        // Legacy terminal outcomes without a phase remain immutable here.
        const revisableProvisionalOutcome = wasPreviouslySettled &&
          (selection.settlementPhase === 'IN_PLAY' || selection.settlementPhase === 'HALF_TIME') &&
          Boolean(selection.settlementSourceFingerprint) &&
          selection.settlementSourceFingerprint !== facts.sourceFingerprint;
        if (wasPreviouslySettled && !options.resettleSettled && !revisableProvisionalOutcome) {
          counts.predictionSelectionsSkipped += 1;
          continue;
        }
        // If a process was interrupted mid-migration and the same one-time pass
        // is resumed, do not append a duplicate audit entry for a selection that
        // already carries this migration label and exactly this source fingerprint.
        const settledEvidence = selection.settlementEvidence && typeof selection.settlementEvidence === 'object'
          ? selection.settlementEvidence as Record<string, unknown>
          : {};
        const resettlementEvidence = settledEvidence.resettlement && typeof settledEvidence.resettlement === 'object'
          ? settledEvidence.resettlement as Record<string, unknown>
          : {};
        const requestedAuditLabel = String(options.auditLabel ?? 'HISTORICAL_RESETTLE').trim() || 'HISTORICAL_RESETTLE';
        if (
          wasPreviouslySettled && options.resettleSettled &&
          String(selection.settlementMethod ?? '').startsWith('HISTORICAL_CORRECTION:') &&
          String(resettlementEvidence.auditLabel ?? '') === requestedAuditLabel &&
          String(selection.settlementSourceFingerprint ?? '') === facts.sourceFingerprint
        ) {
          counts.predictionSelectionsSkipped += 1;
          continue;
        }
        const status =
          typeof selection.status === 'string'
            ? selection.status
            : typeof market.status === 'string'
              ? market.status
              : '';
        if (
          (status === String(PredictionStatus.UNAVAILABLE) ||
            status === String(PredictionStatus.FAILED)) &&
          !(wasPreviouslySettled && options.resettleSettled)
        ) {
          counts.predictionSelectionsSkipped += 1;
          continue;
        }

        const selectionKey = typeof selection.key === 'string' ? selection.key : '';
        const evaluation = this.marketSettlementService.settle(
          marketKey,
          {
            ...selection,
            key: selectionKey || undefined,
            fullName:
              typeof selection.fullName === 'string'
                ? selection.fullName
                : undefined,
          },
          facts,
        );
        const result = {
          ...evaluation,
          evidence: { ...(evaluation.evidence ?? {}),
            sourceFingerprint: facts.sourceFingerprint,
            scoreSource: facts.scoreSource ?? null,
            summaryFactsRevision: facts.summaryFactsRevision ?? null,
            summaryFactsSourcePayloadHash: facts.summaryFactsSourcePayloadHash ?? null,
            summaryFactsCollectedAt: facts.summaryFactsCollectedAt ?? null,
            summaryFactsNormalizationVersion: facts.summaryFactsNormalizationVersion ?? null,
            summaryFactsSectionStatus: facts.summaryFactsSectionStatus ?? null,
            homeStatisticsSource: facts.homeStatisticsSource ?? null,
            awayStatisticsSource: facts.awayStatisticsSource ?? null,
            homeStatisticsCollectedAt: facts.homeStatisticsCollectedAt ?? null,
            awayStatisticsCollectedAt: facts.awayStatisticsCollectedAt ?? null,
            timelineCoverageComplete: facts.timelineCoverageComplete === true,
            timelineCollectedAt: facts.timelineCollectedAt ?? null,
          },
        };
        if (result.outcome === SettlementOutcome.UNRESOLVED) {
          counts.predictionSelectionsUnresolved += 1;
          const reason = `${marketKey}/${selectionKey || String(selection.fullName ?? 'UNKNOWN_SELECTION')}: ${result.reason ?? 'insufficient settlement evidence'}`;
          if (unresolvedReasons.length < 100 && !unresolvedReasons.includes(reason)) {
            unresolvedReasons.push(reason);
          }

          // A historical correction must not leave a known-bad terminal outcome
          // visible simply because the corrected engine cannot prove a replacement.
          // Move that selection back to pending review, retain its old outcome in
          // settlementHistory, and reconcile dependent slips/curated picks below.
          if (revisableProvisionalOutcome && selectionKey) {
            const historyEntry = {
              correctedAt: settledAt,
              auditLabel: 'SPORTS_SOURCE_RECHECK',
              previousOutcome: existingOutcome,
              nextOutcome: null,
              previousMethod: selection.settlementMethod ?? null,
              previousReason: selection.settlementReason ?? null,
              previousEvidence: selection.settlementEvidence ?? null,
              previousSourceFingerprint: selection.settlementSourceFingerprint ?? null,
              previousSettlementPhase: selection.settlementPhase ?? null,
              previousSettledAt: selection.settledAt ?? null,
              nextMethod: 'PROVISIONAL_SETTLEMENT_REVERSED',
              nextReason: result.reason ?? 'The updated Sports source no longer proves the provisional outcome.',
              nextSourceFingerprint: facts.sourceFingerprint,
            };
            const reset = await this.marketPredictionModel.updateOne(
              {
                _id: market._id,
                selections: { $elemMatch: {
                  key: selectionKey,
                  actualOutcome: existingOutcome,
                  settlementSourceFingerprint: selection.settlementSourceFingerprint,
                } },
              },
              {
                $unset: {
                  'selections.$.actualOutcome': 1,
                  'selections.$.settledAt': 1,
                  'selections.$.settlementPhase': 1,
                },
                $set: {
                  'selections.$.settlementMethod': 'PROVISIONAL_SETTLEMENT_REVERSED',
                  'selections.$.settlementReason': result.reason ?? 'Updated Sports evidence no longer proves the provisional outcome.',
                  'selections.$.settlementEvidence': {
                    ...(result.evidence ?? {}),
                    sourceFingerprint: facts.sourceFingerprint,
                    priorProvisionalOutcome: existingOutcome,
                    requiresReevaluation: true,
                    sourceDiagnostics: facts.sourceDiagnostics ?? [],
                    settlementBlockers: facts.settlementBlockers ?? [],
                  },
                  'selections.$.settlementSourceFingerprint': facts.sourceFingerprint,
                },
                $push: { 'selections.$.settlementHistory': historyEntry },
                $addToSet: { 'selections.$.diagnostics': 'PROVISIONAL_SETTLEMENT_REVERSED_BY_SPORTS_SOURCE' },
              },
            ).exec();
            if ((reset.modifiedCount ?? 0) === 0 && unresolvedReasons.length < 100) {
              unresolvedReasons.push(`${reason} The provisional outcome could not be reopened because the selection changed concurrently.`);
            }
          } else if (wasPreviouslySettled && options.resettleSettled && selectionKey) {
            const correctionLabel = String(options.auditLabel ?? 'HISTORICAL_RESETTLE').trim() || 'HISTORICAL_RESETTLE';
            const historyEntry = {
              correctedAt: settledAt,
              auditLabel: options.resettleSettled ? correctionLabel : 'SPORTS_SOURCE_RECHECK',
              previousOutcome: existingOutcome,
              nextOutcome: null,
              previousMethod: selection.settlementMethod ?? null,
              previousReason: selection.settlementReason ?? null,
              previousEvidence: selection.settlementEvidence ?? null,
              previousSourceFingerprint: selection.settlementSourceFingerprint ?? null,
              previousSettlementPhase: selection.settlementPhase ?? null,
              previousSettledAt: selection.settledAt ?? null,
              nextMethod: 'HISTORICAL_CORRECTION_UNRESOLVED',
              nextReason: result.reason ?? 'Insufficient authoritative evidence after historical resettlement.',
              nextSourceFingerprint: facts.sourceFingerprint,
            };
            const correctionEvidence: Record<string, unknown> = {
              ...(result.evidence ?? {}),
              scoreSource: facts.scoreSource ?? null,
              sourceDiagnostics: facts.sourceDiagnostics ?? [],
              conflictingStats: facts.conflictingStats ?? [],
              settlementBlockers: facts.settlementBlockers ?? [],
              resettlement: {
                auditLabel: correctionLabel,
                previousOutcome: existingOutcome,
                previousSourceFingerprint: selection.settlementSourceFingerprint ?? null,
                requiresReview: true,
              },
            };
            const reset = await this.marketPredictionModel.updateOne(
              {
                _id: market._id,
                selections: { $elemMatch: { key: selectionKey, actualOutcome: existingOutcome } },
              },
              {
                $unset: {
                  'selections.$.actualOutcome': 1,
                  'selections.$.settledAt': 1,
                  'selections.$.settlementPhase': 1,
                },
                $set: {
                  'selections.$.settlementMethod': 'HISTORICAL_CORRECTION_UNRESOLVED',
                  'selections.$.settlementReason': result.reason ?? 'Insufficient authoritative evidence after historical resettlement.',
                  'selections.$.settlementEvidence': correctionEvidence,
                  'selections.$.settlementSourceFingerprint': facts.sourceFingerprint,
                },
                $push: { 'selections.$.settlementHistory': historyEntry },
                $addToSet: {
                  'selections.$.diagnostics': {
                    $each: [
                      `RESSETTLEMENT:${correctionLabel}`,
                      `RESSETTLEMENT_OUTCOME:${existingOutcome}->PENDING_REVIEW`,
                    ],
                  },
                },
              },
            ).exec();
            if ((reset.modifiedCount ?? 0) === 0) {
              if (unresolvedReasons.length < 100) unresolvedReasons.push(`${reason} Previous outcome could not be cleared because the source selection changed concurrently.`);
            }
          } else if (wasPreviouslySettled && options.resettleSettled) {
            await this.clearMalformedHistoricalSelection(
              market._id,
              selectionIndex,
              selection,
              existingOutcome,
              facts,
              settledAt,
              String(options.auditLabel ?? 'HISTORICAL_RESETTLE').trim() || 'HISTORICAL_RESETTLE',
              result.reason ?? reason,
              unresolvedReasons,
            );
          }
          continue;
        }

        if (!selectionKey) {
          counts.predictionSelectionsUnresolved += 1;
          const reason = `${marketKey}/UNKNOWN_SELECTION: selection key is missing; outcome was not persisted.`;
          if (unresolvedReasons.length < 100 && !unresolvedReasons.includes(reason)) unresolvedReasons.push(reason);
          // Historical repair must not leave an unaddressable terminal result
          // in place. Market selection subdocuments use {_id:false}, so use the
          // observed array index with compare-and-set guards for malformed legacy
          // records that have no selection key.
          if (wasPreviouslySettled && options.resettleSettled) {
            await this.clearMalformedHistoricalSelection(
              market._id,
              selectionIndex,
              selection,
              existingOutcome,
              facts,
              settledAt,
              String(options.auditLabel ?? 'HISTORICAL_RESETTLE').trim() || 'HISTORICAL_RESETTLE',
              'Selection key is missing; manual review is required.',
              unresolvedReasons,
            );
          }
          continue;
        }

        // Update only this selection, not the full market document. This prevents
        // concurrent event jobs from overwriting settlement results for other
        // selections stored in the same market document.
        const selectionMatch = wasPreviouslySettled && (options.resettleSettled || revisableProvisionalOutcome)
          ? {
              key: selectionKey,
              actualOutcome: existingOutcome,
              ...(revisableProvisionalOutcome ? { settlementSourceFingerprint: selection.settlementSourceFingerprint } : {}),
            }
          : { key: selectionKey, actualOutcome: { $nin: [...PERSISTED_OUTCOMES] } };
        const correctionLabel = String(options.auditLabel ?? 'HISTORICAL_RESETTLE').trim() || 'HISTORICAL_RESETTLE';
        const provisionalOutcomeChanged = revisableProvisionalOutcome && existingOutcome !== result.outcome;
        const historyEntry = (wasPreviouslySettled && options.resettleSettled) || provisionalOutcomeChanged
          ? {
              correctedAt: settledAt,
              auditLabel: options.resettleSettled ? correctionLabel : 'SPORTS_SOURCE_RECHECK',
              previousOutcome: existingOutcome,
              nextOutcome: result.outcome,
              previousMethod: selection.settlementMethod ?? null,
              previousReason: selection.settlementReason ?? null,
              previousEvidence: selection.settlementEvidence ?? null,
              previousSourceFingerprint: selection.settlementSourceFingerprint ?? null,
              previousSettlementPhase: selection.settlementPhase ?? null,
              previousSettledAt: selection.settledAt ?? null,
              nextMethod: result.method,
              nextReason: result.reason ?? null,
              nextSourceFingerprint: facts.sourceFingerprint,
              nextSettlementPhase: result.phase ?? null,
            }
          : undefined;
        const evidence: Record<string, unknown> = {
          ...(result.evidence ?? {}),
          scoreSource: facts.scoreSource ?? null,
          sourceDiagnostics: facts.sourceDiagnostics ?? [],
          conflictingStats: facts.conflictingStats ?? [],
          settlementBlockers: facts.settlementBlockers ?? [],
          ...(wasPreviouslySettled && (options.resettleSettled || revisableProvisionalOutcome)
            ? {
                resettlement: {
                  auditLabel: options.resettleSettled ? correctionLabel : 'SPORTS_SOURCE_RECHECK',
                  previousOutcome: existingOutcome,
                  previousSourceFingerprint: selection.settlementSourceFingerprint ?? null,
                },
              }
            : {}),
        };
        const update = await this.marketPredictionModel.updateOne(
          {
            _id: market._id,
            selections: { $elemMatch: selectionMatch },
          },
          {
            $set: {
              'selections.$.actualOutcome': result.outcome,
              'selections.$.settledAt': settledAt,
              'selections.$.settlementMethod': options.resettleSettled && wasPreviouslySettled
                ? `HISTORICAL_CORRECTION:${result.method}`
                : provisionalOutcomeChanged
                  ? `PROVISIONAL_RECHECK:${result.method}`
                  : result.method,
              'selections.$.settlementReason': result.reason ?? null,
              'selections.$.settlementEvidence': evidence,
              'selections.$.settlementSourceFingerprint': facts.sourceFingerprint,
              'selections.$.settlementPhase': result.phase ?? (facts.isFinished ? 'FULL_TIME' : facts.fixtureState === 'HALFTIME' ? 'HALF_TIME' : 'IN_PLAY'),
            },
            ...(historyEntry ? { $push: { 'selections.$.settlementHistory': historyEntry } } : {}),
            $addToSet: {
              'selections.$.diagnostics': {
                $each: [
                  `SETTLEMENT:${result.method}`,
                  ...(result.reason ? [`SETTLEMENT_NOTE:${result.reason}`] : []),
                  ...(wasPreviouslySettled && options.resettleSettled
                    ? [`RESSETTLEMENT:${correctionLabel}`, `RESSETTLEMENT_OUTCOME:${existingOutcome}->${result.outcome}`]
                    : provisionalOutcomeChanged
                      ? ['PROVISIONAL_SETTLEMENT_SOURCE_RECHECK', `PROVISIONAL_OUTCOME:${existingOutcome}->${result.outcome}`]
                      : []),
                ],
              },
            },
          },
        ).exec();

        if ((update.modifiedCount ?? 0) > 0) {
          counts.predictionSelectionsSettled += 1;
        } else {
          // Another worker may have settled this selection after our read.
          counts.predictionSelectionsSkipped += 1;
        }
      }
    }

    // Reconcile dependent public records only after market selection writes have
    // completed. Missing source selections must never erase an existing outcome.
    if (facts.isFinished) {
      await this.reconcileSlipSettlements(eventId, options.resettleSettled === true);
      await this.reconcileCuratedPredictions(eventId, options.resettleSettled === true);
    }
  }

  /** Admin-only evidence override for one unresolved Prediction Engine selection. */
  async manuallySettleSelection(input: {
    marketPredictionId: string;
    selectionKey: string;
    outcome: PredictionSettlementOutcome;
    reason: string;
    adminId?: string;
  }): Promise<Record<string, unknown>> {
    const marketPredictionId = String(input.marketPredictionId ?? '').trim();
    const selectionKey = String(input.selectionKey ?? '').trim();
    const reason = String(input.reason ?? '').trim();
    const allowed = new Set<string>(Object.values(PredictionSettlementOutcome));
    if (!/^[0-9a-fA-F]{24}$/.test(marketPredictionId)) {
      throw new BadRequestException('Invalid market prediction ID.');
    }
    if (!selectionKey) throw new BadRequestException('selectionKey is required.');
    if (!allowed.has(String(input.outcome))) {
      throw new BadRequestException('Manual settlement requires a resolved selection outcome.');
    }
    if (reason.length < 5 || reason.length > 500) {
      throw new BadRequestException('A settlement reason of 5–500 characters is required.');
    }

    const market = await this.marketPredictionModel.findById(marketPredictionId).exec();
    if (!market) throw new NotFoundException('Market prediction was not found.');
    const selection = (market.selections ?? []).find((item: any) => String(item.key) === selectionKey) as any;
    if (!selection) throw new NotFoundException('Market selection was not found.');

    const existingOutcome = String(selection.actualOutcome ?? '').toUpperCase();
    if (PERSISTED_OUTCOMES.has(existingOutcome)) {
      const alreadyApplied =
        existingOutcome === input.outcome &&
        String(selection.settlementMethod ?? '') === 'MANUAL_ADMIN' &&
        String(selection.settlementReason ?? '') === reason;
      if (!alreadyApplied) {
        throw new ConflictException('This prediction selection is already settled; a separate audited correction workflow is required to change it.');
      }
      await this.reconcileSlipSettlements(String(market.eventId));
      await this.reconcileCuratedPredictions(String(market.eventId));
      return {
        success: true,
        alreadyApplied: true,
        eventId: String(market.eventId),
        marketPredictionId,
        marketKey: String(market.marketKey),
        selectionKey,
        outcome: existingOutcome,
      };
    }

    const settledAt = new Date();
    const adminId = String(input.adminId ?? 'admin').trim() || 'admin';
    const tags = [
      'SETTLEMENT:MANUAL_ADMIN',
      `SETTLEMENT_NOTE:${reason}`,
    ];
    const update = await this.marketPredictionModel.updateOne(
      {
        _id: market._id,
        selections: {
          $elemMatch: {
            key: selectionKey,
            actualOutcome: { $nin: [...PERSISTED_OUTCOMES] },
          },
        },
      },
      {
        $set: {
          'selections.$.actualOutcome': input.outcome,
          'selections.$.settledAt': settledAt,
          'selections.$.settlementMethod': 'MANUAL_ADMIN',
          'selections.$.settlementReason': reason,
          'selections.$.settlementEvidence': {
            adminId,
            reason,
            override: true,
          },
          'selections.$.settlementSourceFingerprint': 'MANUAL_ADMIN',
        },
        $addToSet: { 'selections.$.diagnostics': { $each: tags } },
      },
    ).exec();

    if ((update.modifiedCount ?? 0) === 0) {
      const fresh = await this.marketPredictionModel.findById(market._id).lean().exec() as any;
      const current = (fresh?.selections ?? []).find((item: any) => String(item.key) === selectionKey);
      if (
        String(current?.actualOutcome ?? '').toUpperCase() === input.outcome &&
        String(current?.settlementMethod ?? '') === 'MANUAL_ADMIN' &&
        String(current?.settlementReason ?? '') === reason
      ) {
        await this.reconcileSlipSettlements(String(market.eventId));
        await this.reconcileCuratedPredictions(String(market.eventId));
        return {
          success: true,
          alreadyApplied: true,
          eventId: String(market.eventId),
          marketPredictionId,
          marketKey: String(market.marketKey),
          selectionKey,
          outcome: input.outcome,
        };
      }
      throw new ConflictException('This prediction selection was settled by another process. Refresh the record before retrying.');
    }

    await this.reconcileSlipSettlements(String(market.eventId));
    await this.reconcileCuratedPredictions(String(market.eventId));
    await this.eventLog.write({
      level: SettlementEventLevel.WARN,
      action: 'PREDICTION_SELECTION_MANUALLY_SETTLED',
      message: `Prediction selection ${selectionKey} for event ${String(market.eventId)} was manually settled by ${adminId}.`,
      eventId: String(market.eventId),
      metadata: {
        adminId,
        marketPredictionId,
        marketKey: String(market.marketKey),
        selectionKey,
        outcome: input.outcome,
        reason,
      },
    });

    return {
      success: true,
      alreadyApplied: false,
      eventId: String(market.eventId),
      marketPredictionId,
      marketKey: String(market.marketKey),
      selectionKey,
      outcome: input.outcome,
      settledAt,
    };
  }

  private async clearMalformedHistoricalSelection(
    marketId: Types.ObjectId | string,
    selectionIndex: number,
    selection: SettlementSelection,
    existingOutcome: string,
    facts: SettlementEventFacts,
    correctedAt: Date,
    auditLabel: string,
    reason: string,
    unresolvedReasons: string[],
  ): Promise<void> {
    const indexedOutcome = `selections.${selectionIndex}.actualOutcome`;
    const indexedKey = `selections.${selectionIndex}.key`;
    const indexedHistory = `selections.${selectionIndex}.settlementHistory`;
    const indexedDiagnostics = `selections.${selectionIndex}.diagnostics`;
    const historyEntry = {
      correctedAt,
      auditLabel,
      previousOutcome: existingOutcome,
      nextOutcome: null,
      previousMethod: selection.settlementMethod ?? null,
      previousReason: selection.settlementReason ?? null,
      previousEvidence: selection.settlementEvidence ?? null,
      previousSourceFingerprint: selection.settlementSourceFingerprint ?? null,
      previousSettlementPhase: selection.settlementPhase ?? null,
      previousSettledAt: selection.settledAt ?? null,
      nextMethod: 'HISTORICAL_CORRECTION_UNRESOLVED',
      nextReason: reason,
      nextSourceFingerprint: facts.sourceFingerprint,
    };
    const reset = await this.marketPredictionModel.updateOne(
      {
        _id: marketId,
        [indexedOutcome]: existingOutcome,
        [indexedKey]: { $in: ['', null] },
      },
      {
        $unset: {
          [indexedOutcome]: 1,
          [`selections.${selectionIndex}.settledAt`]: 1,
          [`selections.${selectionIndex}.settlementPhase`]: 1,
        },
        $set: {
          [`selections.${selectionIndex}.settlementMethod`]: 'HISTORICAL_CORRECTION_UNRESOLVED',
          [`selections.${selectionIndex}.settlementReason`]: reason,
          [`selections.${selectionIndex}.settlementEvidence`]: {
            resettlement: { auditLabel, previousOutcome: existingOutcome, requiresReview: true },
            settlementBlockers: facts.settlementBlockers ?? [],
            conflictingStats: facts.conflictingStats ?? [],
            scoreSource: facts.scoreSource ?? null,
            sourceDiagnostics: facts.sourceDiagnostics ?? [],
          },
          [`selections.${selectionIndex}.settlementSourceFingerprint`]: facts.sourceFingerprint,
        },
        $push: { [indexedHistory]: historyEntry },
        $addToSet: {
          [indexedDiagnostics]: {
            $each: [
              `RESSETTLEMENT:${auditLabel}`,
              `RESSETTLEMENT_OUTCOME:${existingOutcome}->PENDING_REVIEW`,
            ],
          },
        },
      },
    ).exec();
    if ((reset.modifiedCount ?? 0) === 0 && unresolvedReasons.length < 100) {
      unresolvedReasons.push(`${reason} Previous outcome could not be cleared because the source selection changed concurrently.`);
    }
  }

  private buildSettlementProjections(
    markets: any[],
    allowTerminalCorrection: boolean,
  ): {
    byId: Map<string, SettlementProjection>;
    byMarketAndKey: Map<string, SettlementProjection>;
  } {
    const byId = new Map<string, SettlementProjection>();
    const byMarketAndKey = new Map<string, SettlementProjection>();
    for (const market of markets ?? []) {
      for (const selection of Array.isArray(market.selections) ? market.selections : []) {
        const rawOutcome = String(selection.actualOutcome ?? '').trim().toUpperCase();
        const method = String(selection.settlementMethod ?? '');
        const sourceRecheck =
          method.startsWith('PROVISIONAL_RECHECK:') ||
          method === 'PROVISIONAL_SETTLEMENT_REVERSED';
        const hasOutcome = PERSISTED_OUTCOMES.has(rawOutcome);
        if (!hasOutcome && !(allowTerminalCorrection || sourceRecheck)) continue;
        const projection: SettlementProjection = {
          outcome: hasOutcome ? rawOutcome : 'PENDING',
          phase: selection.settlementPhase,
          sourceFingerprint: String(selection.settlementSourceFingerprint ?? '').trim() || undefined,
          method: method || undefined,
          reason: String(selection.settlementReason ?? '').trim() || undefined,
          settledAt: selection.settledAt instanceof Date ? selection.settledAt : undefined,
          sourceRecheck,
        };
        const selectionKey = String(selection.key ?? '');
        byId.set(`${String(market._id)}::${selectionKey}`, projection);
        byMarketAndKey.set(`${String(market.marketKey ?? '')}::${selectionKey}`, projection);
      }
    }
    return { byId, byMarketAndKey };
  }

  private shouldApplyProjection(
    existing: any,
    target: SettlementProjection,
    allowTerminalCorrection: boolean,
  ): { apply: boolean; correction: boolean } {
    const currentOutcome = String(existing.settlementOutcome ?? 'PENDING').trim().toUpperCase();
    const currentFingerprint = String(existing.settlementSourceFingerprint ?? '').trim();
    const targetFingerprint = String(target.sourceFingerprint ?? '').trim();
    const currentPhase = String(existing.settlementPhase ?? '').toUpperCase();
    const currentIsTerminal = PERSISTED_OUTCOMES.has(currentOutcome);
    const currentWasProvisional =
      (currentPhase === 'IN_PLAY' || currentPhase === 'HALF_TIME') &&
      Boolean(currentFingerprint) &&
      Boolean(targetFingerprint) &&
      currentFingerprint !== targetFingerprint;
    const correction = currentIsTerminal && (
      allowTerminalCorrection || currentWasProvisional || target.sourceRecheck
    );
    if (currentIsTerminal && !correction) return { apply: false, correction: false };

    const targetPhase = String(target.phase ?? '').toUpperCase();
    const unchanged =
      currentOutcome === target.outcome &&
      currentFingerprint === targetFingerprint &&
      currentPhase === targetPhase;
    if (unchanged) return { apply: false, correction: false };
    return { apply: true, correction: currentIsTerminal };
  }

  private projectionElementMatch(
    eventId: string,
    selection: any,
  ): Record<string, any> {
    const element: Record<string, any> = {
      eventId,
      marketPredictionId: String(selection.marketPredictionId ?? ''),
      marketKey: String(selection.marketKey ?? ''),
      selectionKey: String(selection.selectionKey ?? ''),
      settlementOutcome: selection.settlementOutcome ?? null,
    };
    const fingerprint = String(selection.settlementSourceFingerprint ?? '').trim();
    element.settlementSourceFingerprint = fingerprint
      ? fingerprint
      : { $in: [null, ''] };
    return element;
  }

  private projectionUpdate(
    existing: any,
    target: SettlementProjection,
    correction: boolean,
    reconciliationTime: Date,
  ): Record<string, any> {
    const set: Record<string, any> = {
      'selections.$.settlementOutcome': target.outcome,
    };
    const unset: Record<string, 1> = {};
    const fingerprint = String(target.sourceFingerprint ?? '').trim();
    if (fingerprint) set['selections.$.settlementSourceFingerprint'] = fingerprint;
    else unset['selections.$.settlementSourceFingerprint'] = 1;
    if (target.phase) set['selections.$.settlementPhase'] = target.phase;
    else unset['selections.$.settlementPhase'] = 1;

    if (target.outcome === 'PENDING') {
      set['selections.$.matchSettlementStatus'] = 'PENDING';
      unset['selections.$.settledAt'] = 1;
    } else {
      set['selections.$.settledAt'] = target.settledAt ?? reconciliationTime;
    }

    const update: Record<string, any> = { $set: set };
    if (Object.keys(unset).length) update.$unset = unset;
    if (correction) {
      const historyEntry = {
        correctedAt: reconciliationTime,
        auditLabel: 'SPORTS_SOURCE_RECHECK',
        previousOutcome: String(existing.settlementOutcome ?? 'PENDING'),
        nextOutcome: target.outcome,
        previousPhase: existing.settlementPhase ?? null,
        nextPhase: target.phase ?? null,
        previousSourceFingerprint: existing.settlementSourceFingerprint ?? null,
        nextSourceFingerprint: fingerprint || null,
        previousSettledAt: existing.settledAt ?? null,
        sourceMethod: target.method ?? null,
        reason: target.reason ?? null,
      };
      update.$push = {
        'selections.$.settlementHistory': { $each: [historyEntry], $slice: -20 },
      };
    }
    return update;
  }

  private async reconcileSlipSettlements(
    eventId: string,
    allowTerminalCorrection = false,
  ): Promise<void> {
    const [markets, slips] = await Promise.all([
      this.marketPredictionModel.find({ eventId }).lean().exec(),
      this.predictionSlipModel
        .find({ 'legs.eventId': eventId })
        .select({ _id: 1, legs: 1, settlementStatus: 1 })
        .lean()
        .exec(),
    ]);
    if (!slips.length) return;

    const projections = this.buildSettlementProjections(markets as any[], allowTerminalCorrection);
    const reconciliationTime = new Date();
    for (const slip of slips as any[]) {
      const correctedEventIds = new Set<string>();
      for (const leg of Array.isArray(slip.legs) ? slip.legs : []) {
        if (String(leg.eventId) !== eventId) continue;
        const selectionKey = String(leg.selectionKey ?? '');
        const target = projections.byId.get(`${String(leg.marketPredictionId)}::${selectionKey}`)
          ?? projections.byMarketAndKey.get(`${String(leg.marketKey ?? '')}::${selectionKey}`);
        if (!target) continue;

        const decision = this.shouldApplyProjection(leg, target, allowTerminalCorrection);
        if (!decision.apply) continue;
        const elementMatch = this.projectionElementMatch(eventId, leg);
        const update = this.projectionUpdate(leg, target, decision.correction, reconciliationTime);
        const result = await this.predictionSlipModel.updateOne(
          { _id: slip._id, legs: { $elemMatch: elementMatch } },
          update,
        ).exec();
        if ((result.modifiedCount ?? 0) > 0) correctedEventIds.add(eventId);
      }

      // Re-read after atomic leg writes. This prevents different fixture workers
      // from overwriting one another's nested result arrays.
      const current = await this.predictionSlipModel.findById(slip._id).lean().exec() as any;
      if (!current) continue;
      const legs = Array.isArray(current.legs) ? current.legs : [];
      const byEvent = new Map<string, any[]>();
      for (const leg of legs) {
        const key = String(leg.eventId ?? '');
        const group = byEvent.get(key) ?? [];
        group.push(leg);
        byEvent.set(key, group);
      }
      for (const [fixtureEventId, group] of byEvent) {
        const matchStatus = this.aggregateSettlement(group.map((leg) => String(leg.settlementOutcome ?? 'PENDING')));
        const allowGroupCorrection = allowTerminalCorrection || correctedEventIds.has(fixtureEventId);
        if (matchStatus === 'PENDING' && !allowGroupCorrection) continue;
        await this.predictionSlipModel.updateOne(
          {
            _id: current._id,
            ...(allowGroupCorrection
              ? { legs: { $elemMatch: { eventId: fixtureEventId } } }
              : { legs: { $elemMatch: { eventId: fixtureEventId, matchSettlementStatus: { $in: ['PENDING', null] } } } }),
          },
          { $set: { 'legs.$[leg].matchSettlementStatus': matchStatus } },
          { arrayFilters: [{ 'leg.eventId': fixtureEventId, ...(allowGroupCorrection ? {} : { 'leg.matchSettlementStatus': { $in: ['PENDING', null] } }) }] },
        ).exec();
      }

      const refreshed = await this.predictionSlipModel.findById(current._id).lean().exec() as any;
      if (!refreshed) continue;
      const overall = this.aggregateSettlement((refreshed.legs ?? []).map((leg: any) => String(leg.settlementOutcome ?? 'PENDING')));
      const allowAggregateCorrection = allowTerminalCorrection || correctedEventIds.size > 0;
      if (overall !== 'PENDING' || allowAggregateCorrection) {
        const aggregateUpdate: any = overall === 'PENDING'
          ? { $set: { settlementStatus: 'PENDING' }, $unset: { settledAt: 1 } }
          : { $set: {
              settlementStatus: overall,
              settledAt: allowAggregateCorrection ? reconciliationTime : refreshed.settledAt ?? reconciliationTime,
            } };
        await this.predictionSlipModel.updateOne(
          {
            _id: refreshed._id,
            ...(allowAggregateCorrection ? {} : { settlementStatus: { $in: ['PENDING', null] } }),
          },
          aggregateUpdate,
        ).exec();
      }
    }
  }

  private async reconcileCuratedPredictions(
    eventId: string,
    allowTerminalCorrection = false,
  ): Promise<void> {
    const [markets, predictions] = await Promise.all([
      this.marketPredictionModel.find({ eventId }).lean().exec(),
      this.curatedPredictionModel
        .find({ 'selections.eventId': eventId })
        .select({ _id: 1, status: 1, selections: 1, settlementStatus: 1, settledAt: 1, publishedAt: 1 })
        .lean()
        .exec(),
    ]);
    if (!predictions.length) return;

    const projections = this.buildSettlementProjections(markets as any[], allowTerminalCorrection);
    const reconciliationTime = new Date();
    for (const prediction of predictions as any[]) {
      if (String(prediction.status ?? '').toUpperCase() === 'CANCELLED') continue;
      const correctedEventIds = new Set<string>();
      const selections = Array.isArray(prediction.selections) ? prediction.selections : [];
      for (const selection of selections) {
        if (String(selection.eventId) !== eventId) continue;
        const selectionKey = String(selection.selectionKey ?? '');
        const target = projections.byId.get(`${String(selection.marketPredictionId)}::${selectionKey}`)
          ?? projections.byMarketAndKey.get(`${String(selection.marketKey ?? '')}::${selectionKey}`);
        if (!target) continue;

        const decision = this.shouldApplyProjection(selection, target, allowTerminalCorrection);
        if (!decision.apply) continue;
        const elementMatch = this.projectionElementMatch(eventId, selection);
        const update = this.projectionUpdate(selection, target, decision.correction, reconciliationTime);
        const result = await this.curatedPredictionModel.updateOne(
          {
            _id: prediction._id,
            status: { $ne: 'CANCELLED' },
            selections: { $elemMatch: elementMatch },
          },
          update,
        ).exec();
        if ((result.modifiedCount ?? 0) > 0) correctedEventIds.add(eventId);
      }

      const current = await this.curatedPredictionModel.findById(prediction._id).lean().exec() as any;
      if (!current || String(current.status ?? '').toUpperCase() === 'CANCELLED') continue;
      const currentSelections = Array.isArray(current.selections) ? current.selections : [];
      const byEvent = new Map<string, any[]>();
      for (const selection of currentSelections) {
        const key = String(selection.eventId ?? '');
        const group = byEvent.get(key) ?? [];
        group.push(selection);
        byEvent.set(key, group);
      }
      for (const [fixtureEventId, group] of byEvent) {
        const matchStatus = this.aggregateSettlement(group.map((item) => String(item.settlementOutcome ?? 'PENDING')));
        const allowGroupCorrection = allowTerminalCorrection || correctedEventIds.has(fixtureEventId);
        if (matchStatus === 'PENDING' && !allowGroupCorrection) continue;
        await this.curatedPredictionModel.updateOne(
          {
            _id: current._id,
            status: { $ne: 'CANCELLED' },
            ...(allowGroupCorrection
              ? { selections: { $elemMatch: { eventId: fixtureEventId } } }
              : { selections: { $elemMatch: { eventId: fixtureEventId, matchSettlementStatus: { $in: ['PENDING', null] } } } }),
          },
          { $set: { 'selections.$[selection].matchSettlementStatus': matchStatus } },
          { arrayFilters: [{ 'selection.eventId': fixtureEventId, ...(allowGroupCorrection ? {} : { 'selection.matchSettlementStatus': { $in: ['PENDING', null] } }) }] },
        ).exec();
      }

      const refreshed = await this.curatedPredictionModel.findById(current._id).lean().exec() as any;
      if (!refreshed || String(refreshed.status ?? '').toUpperCase() === 'CANCELLED') continue;
      const overall = this.aggregateSettlement((refreshed.selections ?? []).map((item: any) => String(item.settlementOutcome ?? 'PENDING')));
      const allowAggregateCorrection = allowTerminalCorrection || correctedEventIds.size > 0;
      if (overall !== 'PENDING' || allowAggregateCorrection) {
        // If a source recheck withdraws a provisional result, a published
        // recommendation returns to PUBLISHED; an unpublished one returns READY.
        const aggregateUpdate: any = overall === 'PENDING'
          ? {
              $set: {
                settlementStatus: 'PENDING',
                status: refreshed.publishedAt ? 'PUBLISHED' : 'READY',
              },
              $unset: { settledAt: 1 },
            }
          : { $set: {
              settlementStatus: overall,
              settledAt: allowAggregateCorrection ? reconciliationTime : refreshed.settledAt ?? reconciliationTime,
              status: 'SETTLED',
            } };
        await this.curatedPredictionModel.updateOne(
          {
            _id: refreshed._id,
            status: { $in: ['READY', 'PUBLISHED', 'SETTLED'] },
            ...(allowAggregateCorrection ? {} : { settlementStatus: { $in: ['PENDING', null] } }),
          },
          aggregateUpdate,
        ).exec();
      }
    }
  }

  /**
   * A full loss is terminal immediately. Otherwise a result remains pending until
   * every leg has a known outcome; void/push outcomes do not count as losses.
   */
  private aggregateSettlement(outcomes: string[]): string {
    if (!outcomes.length) return 'PENDING';
    const normalized = outcomes.map((value) => value.toUpperCase());
    if (normalized.includes('LOST')) return 'LOST';
    const known = new Set(['WON', 'VOID', 'PUSH', 'HALF_WON', 'HALF_LOST']);
    if (normalized.some((value) => !known.has(value))) return 'PENDING';
    if (normalized.includes('HALF_LOST')) return 'HALF_LOST';
    if (normalized.includes('HALF_WON')) return 'HALF_WON';
    if (normalized.every((value) => value === 'VOID')) return 'VOID';
    if (normalized.every((value) => value === 'VOID' || value === 'PUSH')) return 'PUSH';
    return 'WON';
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}







