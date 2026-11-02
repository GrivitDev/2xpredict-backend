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
  diagnostics?: unknown;
  settlementHistory?: Array<Record<string, unknown>>;
};

const PERSISTED_OUTCOMES = new Set<string>(Object.values(PredictionSettlementOutcome));

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
        if (wasPreviouslySettled && !options.resettleSettled) {
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
        const result = this.marketSettlementService.settle(
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
          if (wasPreviouslySettled && options.resettleSettled && selectionKey) {
            const correctionLabel = String(options.auditLabel ?? 'HISTORICAL_RESETTLE').trim() || 'HISTORICAL_RESETTLE';
            const historyEntry = {
              correctedAt: settledAt,
              auditLabel: correctionLabel,
              previousOutcome: existingOutcome,
              nextOutcome: null,
              previousMethod: selection.settlementMethod ?? null,
              previousReason: selection.settlementReason ?? null,
              previousEvidence: selection.settlementEvidence ?? null,
              previousSourceFingerprint: selection.settlementSourceFingerprint ?? null,
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
        const selectionMatch = wasPreviouslySettled && options.resettleSettled
          ? { key: selectionKey, actualOutcome: existingOutcome }
          : { key: selectionKey, actualOutcome: { $nin: [...PERSISTED_OUTCOMES] } };
        const correctionLabel = String(options.auditLabel ?? 'HISTORICAL_RESETTLE').trim() || 'HISTORICAL_RESETTLE';
        const historyEntry = wasPreviouslySettled && options.resettleSettled
          ? {
              correctedAt: settledAt,
              auditLabel: correctionLabel,
              previousOutcome: existingOutcome,
              nextOutcome: result.outcome,
              previousMethod: selection.settlementMethod ?? null,
              previousReason: selection.settlementReason ?? null,
              previousEvidence: selection.settlementEvidence ?? null,
              previousSourceFingerprint: selection.settlementSourceFingerprint ?? null,
              previousSettledAt: selection.settledAt ?? null,
              nextMethod: result.method,
              nextReason: result.reason ?? null,
              nextSourceFingerprint: facts.sourceFingerprint,
            }
          : undefined;
        const evidence: Record<string, unknown> = {
          ...(result.evidence ?? {}),
          scoreSource: facts.scoreSource ?? null,
          sourceDiagnostics: facts.sourceDiagnostics ?? [],
          conflictingStats: facts.conflictingStats ?? [],
          settlementBlockers: facts.settlementBlockers ?? [],
          ...(wasPreviouslySettled && options.resettleSettled
            ? {
                resettlement: {
                  auditLabel: correctionLabel,
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
                : result.method,
              'selections.$.settlementReason': result.reason ?? null,
              'selections.$.settlementEvidence': evidence,
              'selections.$.settlementSourceFingerprint': facts.sourceFingerprint,
            },
            ...(historyEntry ? { $push: { 'selections.$.settlementHistory': historyEntry } } : {}),
            $addToSet: {
              'selections.$.diagnostics': {
                $each: [
                  `SETTLEMENT:${result.method}`,
                  ...(result.reason ? [`SETTLEMENT_NOTE:${result.reason}`] : []),
                  ...(wasPreviouslySettled && options.resettleSettled
                    ? [`RESSETTLEMENT:${correctionLabel}`, `RESSETTLEMENT_OUTCOME:${existingOutcome}->${result.outcome}`]
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
    await this.reconcileSlipSettlements(eventId, options.resettleSettled === true);
    await this.reconcileCuratedPredictions(eventId, options.resettleSettled === true);
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
        $unset: { [indexedOutcome]: 1, [`selections.${selectionIndex}.settledAt`]: 1 },
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

  private async reconcileSlipSettlements(
    eventId: string,
    allowTerminalCorrection = false,
  ): Promise<void> {
    const [markets, slips] = await Promise.all([
      this.marketPredictionModel.find({ eventId }).lean().exec(),
      this.predictionSlipModel.find({ 'legs.eventId': eventId }).select({ _id: 1, legs: 1, settlementStatus: 1 }).lean().exec(),
    ]);
    if (!slips.length) return;

    const outcomesById = new Map<string, string>();
    const outcomesByMarketAndKey = new Map<string, string>();
    for (const market of markets as any[]) {
      for (const selection of Array.isArray(market.selections) ? market.selections : []) {
        const rawOutcome = String(selection.actualOutcome ?? '').trim().toUpperCase();
        const selectionKey = String(selection.key ?? '');
        if (allowTerminalCorrection) {
          const outcome = PERSISTED_OUTCOMES.has(rawOutcome) ? rawOutcome : 'PENDING';
          outcomesById.set(`${String(market._id)}::${selectionKey}`, outcome);
          outcomesByMarketAndKey.set(`${String(market.marketKey ?? '')}::${selectionKey}`, outcome);
        } else if (PERSISTED_OUTCOMES.has(rawOutcome)) {
          outcomesById.set(`${String(market._id)}::${selectionKey}`, rawOutcome);
          outcomesByMarketAndKey.set(`${String(market.marketKey ?? '')}::${selectionKey}`, rawOutcome);
        }
      }
    }

    const settledOutcomes = [...PERSISTED_OUTCOMES];
    const reconciliationTime = new Date();
    for (const slip of slips as any[]) {
      for (const leg of Array.isArray(slip.legs) ? slip.legs : []) {
        if (String(leg.eventId) !== eventId) continue;
        const selectionKey = String(leg.selectionKey ?? '');
        const outcome = outcomesById.get(`${String(leg.marketPredictionId)}::${selectionKey}`)
          ?? outcomesByMarketAndKey.get(`${String(leg.marketKey ?? '')}::${selectionKey}`);
        if (!outcome) continue;

        if (!PERSISTED_OUTCOMES.has(outcome) && !(allowTerminalCorrection && outcome === 'PENDING')) continue;
        const update: any = allowTerminalCorrection && outcome === 'PENDING'
          ? {
              $set: {
                'legs.$.settlementOutcome': 'PENDING',
                'legs.$.matchSettlementStatus': 'PENDING',
              },
              $unset: { 'legs.$.settledAt': 1 },
            }
          : {
              $set: {
                'legs.$.settlementOutcome': outcome,
                'legs.$.settledAt': reconciliationTime,
              },
            };
        await this.predictionSlipModel.updateOne(
          {
            _id: slip._id,
            legs: {
              $elemMatch: {
                eventId,
                marketPredictionId: String(leg.marketPredictionId ?? ''),
                marketKey: String(leg.marketKey ?? ''),
                selectionKey,
                ...(allowTerminalCorrection ? {} : { settlementOutcome: { $nin: settledOutcomes } }),
              },
            },
          },
          update,
        ).exec();
      }

      // Re-read after individual atomic leg writes so concurrent jobs for other
      // fixtures cannot lose one another's updates by saving a stale whole array.
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
        if (matchStatus === 'PENDING' && !allowTerminalCorrection) continue;
        await this.predictionSlipModel.updateOne(
          {
            _id: current._id,
            ...(allowTerminalCorrection
              ? { legs: { $elemMatch: { eventId: fixtureEventId } } }
              : { legs: { $elemMatch: { eventId: fixtureEventId, matchSettlementStatus: { $in: ['PENDING', null] } } } }),
          },
          { $set: { 'legs.$[leg].matchSettlementStatus': matchStatus } },
          { arrayFilters: [{ 'leg.eventId': fixtureEventId, ...(allowTerminalCorrection ? {} : { 'leg.matchSettlementStatus': { $in: ['PENDING', null] } }) }] },
        ).exec();
      }

      // Aggregate states advance from PENDING to a resolved outcome only. This
      // conditional update prevents a slow concurrent job from reverting a final
      // result to PENDING or replacing one terminal outcome with another.
      const refreshed = await this.predictionSlipModel.findById(current._id).lean().exec() as any;
      if (!refreshed) continue;
      const overall = this.aggregateSettlement((refreshed.legs ?? []).map((leg: any) => String(leg.settlementOutcome ?? 'PENDING')));
      if (overall !== 'PENDING' || allowTerminalCorrection) {
        const aggregateUpdate: any = overall === 'PENDING'
          ? { $set: { settlementStatus: 'PENDING' }, $unset: { settledAt: 1 } }
          : { $set: {
              settlementStatus: overall,
              settledAt: allowTerminalCorrection ? reconciliationTime : refreshed.settledAt ?? reconciliationTime,
            } };
        await this.predictionSlipModel.updateOne(
          {
            _id: refreshed._id,
            ...(allowTerminalCorrection ? {} : { settlementStatus: { $in: ['PENDING', null] } }),
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
      this.curatedPredictionModel.find({ 'selections.eventId': eventId }).select({ _id: 1, status: 1, selections: 1, settlementStatus: 1, settledAt: 1, publishedAt: 1 }).lean().exec(),
    ]);
    if (!predictions.length) return;

    const outcomes = new Map<string, string>();
    const outcomesByMarketAndKey = new Map<string, string>();
    for (const market of markets as any[]) {
      for (const selection of Array.isArray(market.selections) ? market.selections : []) {
        const rawOutcome = String(selection.actualOutcome ?? '').toUpperCase();
        const selectionKey = String(selection.key ?? '');
        if (allowTerminalCorrection) {
          const outcome = PERSISTED_OUTCOMES.has(rawOutcome) ? rawOutcome : 'PENDING';
          outcomes.set(`${String(market._id)}::${selectionKey}`, outcome);
          outcomesByMarketAndKey.set(`${String(market.marketKey ?? '')}::${selectionKey}`, outcome);
        } else if (PERSISTED_OUTCOMES.has(rawOutcome)) {
          outcomes.set(`${String(market._id)}::${selectionKey}`, rawOutcome);
          outcomesByMarketAndKey.set(`${String(market.marketKey ?? '')}::${selectionKey}`, rawOutcome);
        }
      }
    }

    const settledOutcomes = [...PERSISTED_OUTCOMES];
    const reconciliationTime = new Date();
    for (const prediction of predictions as any[]) {
      if (String(prediction.status ?? '').toUpperCase() === 'CANCELLED') continue;
      const selections = Array.isArray(prediction.selections) ? prediction.selections : [];
      for (const selection of selections) {
        if (String(selection.eventId) !== eventId) continue;
        const selectionKey = String(selection.selectionKey ?? '');
        const outcome = outcomes.get(`${String(selection.marketPredictionId)}::${selectionKey}`)
          ?? outcomesByMarketAndKey.get(`${String(selection.marketKey ?? '')}::${selectionKey}`);
        if (!outcome) continue;
        if (!PERSISTED_OUTCOMES.has(outcome) && !(allowTerminalCorrection && outcome === 'PENDING')) continue;
        const update: any = allowTerminalCorrection && outcome === 'PENDING'
          ? {
              $set: {
                'selections.$.settlementOutcome': 'PENDING',
                'selections.$.matchSettlementStatus': 'PENDING',
              },
              $unset: { 'selections.$.settledAt': 1 },
            }
          : {
              $set: {
                'selections.$.settlementOutcome': outcome,
                'selections.$.settledAt': reconciliationTime,
              },
            };
        await this.curatedPredictionModel.updateOne(
          {
            _id: prediction._id,
            status: { $ne: 'CANCELLED' },
            selections: {
              $elemMatch: {
                eventId,
                marketPredictionId: String(selection.marketPredictionId ?? ''),
                selectionKey,
                ...(allowTerminalCorrection ? {} : { settlementOutcome: { $nin: settledOutcomes } }),
              },
            },
          },
          update,
        ).exec();
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
        if (matchStatus === 'PENDING' && !allowTerminalCorrection) continue;
        await this.curatedPredictionModel.updateOne(
          {
            _id: current._id,
            status: { $ne: 'CANCELLED' },
            ...(allowTerminalCorrection
              ? { selections: { $elemMatch: { eventId: fixtureEventId } } }
              : { selections: { $elemMatch: { eventId: fixtureEventId, matchSettlementStatus: { $in: ['PENDING', null] } } } }),
          },
          { $set: { 'selections.$[selection].matchSettlementStatus': matchStatus } },
          { arrayFilters: [{ 'selection.eventId': fixtureEventId, ...(allowTerminalCorrection ? {} : { 'selection.matchSettlementStatus': { $in: ['PENDING', null] } }) }] },
        ).exec();
      }

      const refreshed = await this.curatedPredictionModel.findById(current._id).lean().exec() as any;
      if (!refreshed || String(refreshed.status ?? '').toUpperCase() === 'CANCELLED') continue;
      const overall = this.aggregateSettlement((refreshed.selections ?? []).map((item: any) => String(item.settlementOutcome ?? 'PENDING')));
      if (overall !== 'PENDING' || allowTerminalCorrection) {
        // Historical correction can reopen a previously SETTLED recommendation
        // only when the corrected evidence is insufficient. It is restored to
        // PUBLISHED when it had a publication timestamp; otherwise READY.
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
              settledAt: allowTerminalCorrection ? reconciliationTime : refreshed.settledAt ?? reconciliationTime,
              status: 'SETTLED',
            } };
        await this.curatedPredictionModel.updateOne(
          {
            _id: refreshed._id,
            status: { $in: ['READY', 'PUBLISHED', 'SETTLED'] },
            ...(allowTerminalCorrection ? {} : { settlementStatus: { $in: ['PENDING', null] } }),
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




