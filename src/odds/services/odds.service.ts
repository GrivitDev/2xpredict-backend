import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { EspnFixture } from '../../sports/schemas/espn/espn-fixture.schema';
import { FixtureOdds } from '../schemas/fixture-odds.schema';
import { ODDS_CONFIG } from '../config/odds.config';
import { PREDICTION_ENGINE_CONFIG } from '../../predictions-engine/config/prediction-engine.config';
import {
  CanonicalProviderQuote,
  StoredOddsProvider,
} from '../providers/odds-provider.interfaces';
import {
  CanonicalMarketDefinition,
  CanonicalPriceType,
  FOOTBALL_MARKET_CATALOG,
  canonicalLineSlug,
  expandCanonicalSelections,
} from '../catalog/football-market-catalog';

const INITIAL_ODDS_WINDOW_MS = ODDS_CONFIG.lookaheadHours * 60 * 60_000;
const RETAIN_AFTER_COMPLETION_DAYS = 7;
const MINIMUM_STAT_SAMPLE = 3;
const MAX_DECIMAL_ODDS = 100000;
const MAX_GOALS = 10;

type PlainRecord = Record<string, any>;
type ExpiryFixture = {
  _id: Types.ObjectId;
  eventId?: string | null;
  completedAt?: Date | string | null;
};
export type OddsBasis =
  | 'BOOKMAKER_ONLY'
  | 'BOOKMAKER_PLUS_HISTORY'
  | 'HISTORICAL_ONLY'
  | 'PRIOR_ONLY';
export type OddsCalculationMethod =
  | 'ESPN_PICKCENTER'
  | 'ESPN_SUMMARY_ODDS'
  | 'THE_ODDS_API'
  | 'HISTORICAL_POISSON_MODEL'
  | 'BOOKMAKER_BLENDED_SCORE_MATRIX'
  | 'HISTORICAL_COUNT_MODEL'
  | 'GENERIC_PRIOR';
type Price = {
  eventId: string;
  marketId: string;
  selectionKey: string;
  line?: number;
  decimalOdds: number;
  priceType: CanonicalPriceType;
  fairOdds?: number | null;
  fairOddsBasis?: 'MODEL' | 'PRIOR';
  marketFairOdds?: number | null;
  impliedProbability?: number | null;
  valuePercent?: number | null;
  provider?: StoredOddsProvider;
  bookmaker?: string;
  providerUpdatedAt?: Date;
  oddsBasis?: OddsBasis;
  oddsCalculationMethod?: OddsCalculationMethod;
};

type PriceMetadata = Partial<
  Pick<
    Price,
    | 'fairOddsBasis'
    | 'marketFairOdds'
    | 'provider'
    | 'bookmaker'
    | 'providerUpdatedAt'
    | 'oddsBasis'
    | 'oddsCalculationMethod'
  >
>;

type TeamStats = Record<string, number>;
interface GoalMetrics {
  scored: number[];
  conceded: number[];
  homeScored: number[];
  homeConceded: number[];
  awayScored: number[];
  awayConceded: number[];
}

@Injectable()
export class OddsService {
  private expiryFixtureCursor: Types.ObjectId | null = null;
  private readonly noPriceEvaluationAt = new Map<string, number>();

  constructor(
    @InjectModel(EspnFixture.name)
    private readonly fixtureModel: Model<EspnFixture>,
    @InjectModel(FixtureOdds.name)
    private readonly oddsModel: Model<FixtureOdds>,
  ) {}

  /** True when ESPN Summary contains at least one valid direct bookmaker quote. */
  hasUsableSummaryProviderOdds(fixture: Record<string, any>): boolean {
    let found = false;
    this.extractProviderPrices(
      fixture,
      (_marketId, _selectionKey, _line, odds, priceType, metadata) => {
        if (
          priceType === 'PROVIDER' &&
          typeof odds === 'number' &&
          Number.isFinite(odds) &&
          odds > 1 &&
          metadata?.oddsBasis === 'BOOKMAKER_ONLY' &&
          Boolean(metadata?.oddsCalculationMethod)
        )
          found = true;
      },
    );
    return found;
  }

  /**
   * Provider fallback is assessed against complete usable 1X2, goal-total and
   * Asian-handicap outcome pairs, not merely non-empty ESPN containers. Other
   * canonical markets may use explicitly labelled model/history prices.
   */
  getSummaryProviderCoverage(fixture: Record<string, any>): {
    quoteCount: number;
    completeMatchResult: boolean;
    hasGoalTotals: boolean;
    hasAsianHandicap: boolean;
    needsFallback: boolean;
  } {
    const quotes = new Set<string>();
    this.extractProviderPrices(
      fixture,
      (marketId, selectionKey, line, odds, priceType, metadata) => {
        if (
          priceType !== 'PROVIDER' ||
          typeof odds !== 'number' ||
          !Number.isFinite(odds) ||
          odds <= 1 ||
          metadata?.oddsBasis !== 'BOOKMAKER_ONLY' ||
          !metadata?.oddsCalculationMethod
        )
          return;
        quotes.add(
          `${marketId}:${selectionKey}:${line === undefined ? '-' : line}`,
        );
      },
    );
    const hasHome = quotes.has('MATCH_RESULT:HOME_WIN:-');
    const hasDraw = quotes.has('MATCH_RESULT:DRAW:-');
    const hasAway = quotes.has('MATCH_RESULT:AWAY_WIN:-');
    let hasGoalTotals = false;
    for (const key of quotes) {
      const match = key.match(
        /^TOTAL_GOALS_OVER_UNDER:(OVER|UNDER)_(MINUS_)?([0-9]+(?:_[0-9]+)?):(.+)$/,
      );
      if (!match) continue;
      const lineSlug = `${match[2] ?? ''}${match[3]}`;
      const lineSuffix = match[4];
      const overKey = `TOTAL_GOALS_OVER_UNDER:OVER_${lineSlug}:${lineSuffix}`;
      const underKey = `TOTAL_GOALS_OVER_UNDER:UNDER_${lineSlug}:${lineSuffix}`;
      if (quotes.has(overKey) && quotes.has(underKey)) hasGoalTotals = true;
    }
    const homeHandicapLines = new Set<number>();
    const awayHandicapLines = new Set<number>();
    for (const key of quotes) {
      const match = key.match(
        /^ASIAN_HANDICAP:(HOME|AWAY)_(MINUS_)?([0-9]+(?:_[0-9]+)?):(.+)$/,
      );
      if (!match) continue;
      const line = Number(match[4]);
      if (!Number.isFinite(line)) continue;
      (match[1] === 'HOME' ? homeHandicapLines : awayHandicapLines).add(
        Math.abs(line),
      );
    }
    // Provider spreads often express the opposing sides as -0.5 and +0.5.
    // Pair by absolute handicap so sign convention does not fake missing coverage.
    const hasAsianHandicap = [...homeHandicapLines].some((line) =>
      awayHandicapLines.has(line),
    );
    const completeMatchResult = hasHome && hasDraw && hasAway;
    return {
      quoteCount: quotes.size,
      completeMatchResult,
      hasGoalTotals,
      hasAsianHandicap,
      needsFallback:
        !completeMatchResult || !hasGoalTotals || !hasAsianHandicap,
    };
  }

  async getFixturePrices(eventId: string): Promise<any[]> {
    return this.oddsModel
      .find({
        eventId: String(eventId).trim(),
        $or: [
          { expiresAt: { $exists: false } },
          { expiresAt: { $gt: new Date() } },
        ],
      })
      .sort({ marketId: 1, selectionKey: 1, line: 1 })
      .lean()
      .exec();
  }

  async getPricesForFixtures(eventIds: string[]): Promise<any[]> {
    const ids = [
      ...new Set(eventIds.map((id) => String(id).trim()).filter(Boolean)),
    ];
    if (!ids.length) return [];
    return (
      this.oddsModel
        .find({
          eventId: { $in: ids },
          $or: [
            { expiresAt: { $exists: false } },
            { expiresAt: { $gt: new Date() } },
          ],
        })
        // Bet Lab and Odds Center consume this canonical price contract only.
        // Avoid transferring internal bookkeeping fields from every matched row.
        .select({
          _id: 0,
          eventId: 1,
          marketId: 1,
          selectionKey: 1,
          line: 1,
          decimalOdds: 1,
          priceType: 1,
          provider: 1,
          bookmaker: 1,
          fairOdds: 1,
          fairOddsBasis: 1,
          marketFairOdds: 1,
          impliedProbability: 1,
          valuePercent: 1,
          oddsBasis: 1,
          oddsCalculationMethod: 1,
          providerUpdatedAt: 1,
          updatedAt: 1,
          predictionReady: 1,
        })
        .lean()
        .exec()
    );
  }

  /**
   * Authoritative Odds-module readiness for Prediction Engine queueing. A
   * fixture is ready when the Odds module has at least one valid canonical
   * selection price. It does not require every market to be priced or a direct
   * bookmaker quote at fixture level. Each exact selection is validated later;
   * Pick Center and betting products still distinguish real provider prices.
   */
  async getPredictionReadinessForEvents(eventIds: string[]): Promise<
    Map<
      string,
      {
        eventId: string;
        ready: boolean;
        expectedSelections: number;
        pricedSelections: number;
        missingSelections: number;
        latestOddsUpdatedAt: Date | null;
        readySelections: number;
        bookmakerSelections: number;
        bookmakerInformedEstimates: number;
        historicalEstimates: number;
        priorOnlySelections: number;
        reason: string | null;
      }
    >
  > {
    const ids = [
      ...new Set(eventIds.map((id) => String(id).trim()).filter(Boolean)),
    ];
    if (!ids.length) return new Map();
    const supportedMarketIds = FOOTBALL_MARKET_CATALOG.map(
      (market) => market.id,
    );
    const supportedMarketIdSet = new Set(supportedMarketIds);
    const validOddsBases = [
      'BOOKMAKER_ONLY',
      'BOOKMAKER_PLUS_HISTORY',
      'HISTORICAL_ONLY',
      'PRIOR_ONLY',
    ] as const;
    const readinessCheckedAt = new Date();
    const [fixtures, rows] = await Promise.all([
      this.fixtureModel
        .find({ eventId: { $in: ids } })
        .select({
          eventId: 1,
          homeTeamId: 1,
          awayTeamId: 1,
          completed: 1,
          status: 1,
          statusDetail: 1,
          statusShortDetail: 1,
          'payload.competitions.competitors.homeAway': 1,
          'payload.competitions.competitors.team.displayName': 1,
          'payload.competitions.competitors.team.name': 1,
          'payload.competitions.status': 1,
          'payload.summary.header.competitions.status': 1,
        })
        .lean()
        .exec() as Promise<PlainRecord[]>,
      this.oddsModel
        .find({
          eventId: { $in: ids },
          predictionReady: true,
          marketId: { $in: supportedMarketIds },
          priceType: { $in: ['PROVIDER', 'ESTIMATED'] },
          oddsBasis: { $in: validOddsBases },
          oddsCalculationMethod: { $type: 'string', $regex: /\S/ },
          $or: [
            { expiresAt: { $exists: false } },
            { expiresAt: { $gt: readinessCheckedAt } },
          ],
        })
        .select({
          eventId: 1,
          marketId: 1,
          selectionKey: 1,
          line: 1,
          decimalOdds: 1,
          priceType: 1,
          provider: 1,
          bookmaker: 1,
          providerUpdatedAt: 1,
          updatedAt: 1,
          oddsBasis: 1,
          oddsCalculationMethod: 1,
          predictionReady: 1,
        })
        .lean()
        .exec() as Promise<PlainRecord[]>,
    ]);
    const byEvent = new Map<string, PlainRecord[]>();
    for (const row of rows) {
      const list = byEvent.get(String(row.eventId)) ?? [];
      list.push(row);
      byEvent.set(String(row.eventId), list);
    }
    const result = new Map<string, any>();
    for (const fixture of fixtures) {
      const eventId = String(fixture.eventId);
      const fixturePayload = this.asRecord(fixture.payload);
      const fixtureSummary = this.asRecord(fixturePayload.summary);
      const nestedStatusParts: unknown[] = [
        ...this.asArray(this.asRecord(fixturePayload).competitions).flatMap(
          (item): unknown[] => {
            const status = this.asRecord(this.asRecord(item).status);
            const type = this.asRecord(status.type);
            return [
              status.name,
              status.detail,
              status.shortDetail,
              status.state,
              type.name,
              type.detail,
              type.shortDetail,
              type.state,
            ] as unknown[];
          },
        ),
        ...this.asArray(
          this.asRecord(fixtureSummary.header).competitions,
        ).flatMap((item): unknown[] => {
          const status = this.asRecord(this.asRecord(item).status);
          const type = this.asRecord(status.type);
          return [
            status.name,
            status.detail,
            status.shortDetail,
            status.state,
            type.name,
            type.detail,
            type.shortDetail,
            type.state,
          ] as unknown[];
        }),
      ];
      const fixtureStatus = [
        fixture.status,
        fixture.statusDetail,
        fixture.statusShortDetail,
        ...nestedStatusParts,
      ]
        .filter(Boolean)
        .map(String)
        .join(' ');
      const fixtureUnavailable =
        fixture.completed === true ||
        /(^|[^A-Z])(FINAL|FINISHED|FULL[ _-]?TIME|AFTER EXTRA TIME|AFTER PENALTIES|FT)([^A-Z]|$)/i.test(
          fixtureStatus,
        ) ||
        /postpon|cancel|abandon|delay/i.test(fixtureStatus) ||
        nestedStatusParts.some(
          (value) =>
            typeof value === 'string' &&
            /^(?:postponed|cancelled|canceled|abandoned|delayed)$/i.test(
              value.trim(),
            ),
        );
      const expected = this.expectedSelectionKeys(fixture);
      const availableRows = byEvent.get(eventId) ?? [];
      const valid = new Map<string, PlainRecord>();
      for (const row of availableRows) {
        // Only rows explicitly endorsed by the Odds module can unlock a market.
        if (row.predictionReady !== true) continue;
        const decimalOdds = Number(row.decimalOdds);
        if (
          !Number.isFinite(decimalOdds) ||
          decimalOdds < 1.01 ||
          decimalOdds > MAX_DECIMAL_ODDS
        )
          continue;
        if (row.priceType !== 'PROVIDER' && row.priceType !== 'ESTIMATED')
          continue;
        if (
          ![
            'BOOKMAKER_ONLY',
            'BOOKMAKER_PLUS_HISTORY',
            'HISTORICAL_ONLY',
            'PRIOR_ONLY',
          ].includes(String(row.oddsBasis))
        )
          continue;
        if (!String(row.oddsCalculationMethod ?? '').trim()) continue;
        // The stored document's updatedAt is not proof that the bookmaker quote
        // itself is fresh. Apply the same provider timestamp contract to ESPN and
        // The Odds API; estimated prices retain their explicit estimate label.
        if (row.priceType === 'PROVIDER') {
          const quoteAt = this.toDate(row.providerUpdatedAt);
          const age = quoteAt
            ? Date.now() - quoteAt.getTime()
            : Number.POSITIVE_INFINITY;
          if (
            !quoteAt ||
            age < -5 * 60_000 ||
            age >
              PREDICTION_ENGINE_CONFIG.model.maximumProviderOddsAgeHours *
                3_600_000
          )
            continue;
        }
        valid.set(
          this.priceKey(
            String(row.marketId),
            String(row.selectionKey),
            row.line === undefined || row.line === null
              ? undefined
              : Number(row.line),
          ),
          row,
        );
      }
      const missing = expected.filter((key) => !valid.has(key));
      // Include valid Odds rows for non-default lines as well as the preset
      // canonical selections. They may be ready even when the preset lines are not.
      const selectedRows = Array.from(valid.values()).filter((row) =>
        supportedMarketIdSet.has(String(row.marketId)),
      );
      const basisCount = (basis: string) =>
        selectedRows.filter((row) => row.oddsBasis === basis).length;
      const latestOddsUpdatedAt = selectedRows.reduce(
        (latest: Date | null, row: PlainRecord) => {
          const timestamps = [
            this.toDate(row.providerUpdatedAt),
            this.toDate(row.updatedAt),
          ].filter((value): value is Date => value !== null);
          const timestamp = timestamps.reduce(
            (newest, value) =>
              value.getTime() > newest.getTime() ? value : newest,
            timestamps[0] ?? new Date(0),
          );
          return timestamp.getTime() > 0 &&
            (!latest || timestamp.getTime() > latest.getTime())
            ? timestamp
            : latest;
        },
        null,
      );
      // Require at least one Odds-ready row that matches a selection the market
      // calculator can actually expand. Include valid non-default lines: Odds
      // can legitimately provide a line that is not in the preset catalogue.
      const readySelections = expected.length - missing.length;
      const homeTeamName = this.teamName(fixture, 'home');
      const awayTeamName = this.teamName(fixture, 'away');
      const hasUsableSelection = selectedRows.some((row) => {
        const market = FOOTBALL_MARKET_CATALOG.find(
          (item) => item.id === String(row.marketId),
        );
        if (!market) return false;
        const rowLine =
          row.line === undefined || row.line === null
            ? undefined
            : Number(row.line);
        if (rowLine !== undefined && !Number.isFinite(rowLine)) return false;

        const expandedMarket =
          market.selectionMode === 'STATIC' || rowLine === undefined
            ? market
            : {
                ...market,
                lines: [...new Set([...(market.lines ?? []), rowLine])],
              };
        return expandCanonicalSelections(
          expandedMarket,
          homeTeamName,
          awayTeamName,
        ).some((selection) => {
          if (selection.key !== String(row.selectionKey)) return false;
          if (selection.line === undefined) return rowLine === undefined;
          return (
            rowLine !== undefined && Math.abs(selection.line - rowLine) < 0.001
          );
        });
      });
      const ready =
        !fixtureUnavailable && expected.length > 0 && hasUsableSelection;
      result.set(eventId, {
        eventId,
        ready,
        expectedSelections: expected.length,
        pricedSelections: selectedRows.length,
        missingSelections: missing.length,
        readySelections,
        latestOddsUpdatedAt,
        bookmakerSelections: basisCount('BOOKMAKER_ONLY'),
        bookmakerInformedEstimates: basisCount('BOOKMAKER_PLUS_HISTORY'),
        historicalEstimates: basisCount('HISTORICAL_ONLY'),
        priorOnlySelections: basisCount('PRIOR_ONLY'),
        reason: ready
          ? null
          : fixtureUnavailable
            ? 'Fixture is completed, postponed, cancelled, abandoned, or otherwise unavailable for prediction.'
            : !expected.length
              ? 'No canonical selections were generated for this fixture.'
              : 'No supported market selection currently has an Odds-module-endorsed usable price.',
      });
    }
    for (const eventId of ids) {
      if (!result.has(eventId))
        result.set(eventId, {
          eventId,
          ready: false,
          expectedSelections: 0,
          pricedSelections: 0,
          missingSelections: 0,
          readySelections: 0,
          latestOddsUpdatedAt: null,
          bookmakerSelections: 0,
          bookmakerInformedEstimates: 0,
          historicalEstimates: 0,
          priorOnlySelections: 0,
          reason: 'ESPN fixture was not found.',
        });
    }
    return result;
  }

  async refreshFixture(
    eventId: string,
    providerQuotes: CanonicalProviderQuote[] = [],
    providerSourceUpdatedAt?: Date,
  ): Promise<number> {
    const fixture = (await this.fixtureModel
      .findOne({ eventId })
      .select({
        eventId: 1,
        leagueId: 1,
        fixtureDate: 1,
        completed: 1,
        completedAt: 1,
        live: 1,
        status: 1,
        statusDetail: 1,
        statusShortDetail: 1,
        homeTeamId: 1,
        awayTeamId: 1,
        homeScore: 1,
        awayScore: 1,
        collectedAt: 1,
        fixtureCollectedAt: 1,
        'payload.summary.meta.lastUpdatedAt': 1,
        'payload.summary.odds': 1,
        'payload.summary.pickcenter': 1,
        'payload.summary.header.competitions': 1,
        'payload.summaryCollectedAt': 1,
        'payload.competitions.competitors': 1,
        'payload.competitions.odds': 1,
        'payload.competitions.status': 1,
      })
      .lean()
      .exec()) as PlainRecord | null;
    if (!fixture) return 0;

    const fixturePayloadForStatus = this.asRecord(fixture.payload);
    const summaryHeaderForStatus = this.asRecord(
      this.asRecord(fixturePayloadForStatus.summary).header,
    );
    const statusCompetitions = [
      ...this.asArray(fixturePayloadForStatus.competitions),
      ...this.asArray(summaryHeaderForStatus.competitions),
    ];
    const nestedStatusText = statusCompetitions
      .flatMap((item) => {
        const competition = this.asRecord(item);
        const status = this.asRecord(competition.status);
        const type = this.asRecord(status.type);
        return [
          status.name,
          status.detail,
          status.shortDetail,
          type.name,
          type.detail,
          type.shortDetail,
        ]
          .filter((value) => value !== undefined && value !== null)
          .map(String);
      })
      .join(' ');
    const rootStatusText = `${fixture.status ?? ''} ${fixture.statusDetail ?? ''} ${fixture.statusShortDetail ?? ''}`;
    const finishedByStatus =
      /(^|[^A-Z])(FINAL|FINISHED|FULL[ _-]?TIME|AFTER EXTRA TIME|AFTER PENALTIES|FT)([^A-Z]|$)/i.test(
        `${rootStatusText} ${nestedStatusText}`,
      ) ||
      statusCompetitions.some((item) => {
        const status = this.asRecord(this.asRecord(item).status);
        const type = this.asRecord(status.type);
        return status.completed === true || type.completed === true;
      });
    const unavailableByStatus =
      /postpon|cancel|abandon|delay|suspend|void/i.test(
        `${rootStatusText} ${nestedStatusText}`,
      );

    if (fixture.completed === true) {
      this.noPriceEvaluationAt.delete(String(fixture.eventId));
      // Expiry must be anchored to the actual completion time, never the
      // originally scheduled kickoff or an unrelated collection timestamp.
      const completedAt = this.toDate(fixture.completedAt);
      if (completedAt) {
        const expiresAt = new Date(
          completedAt.getTime() + RETAIN_AFTER_COMPLETION_DAYS * 86_400_000,
        );
        await this.oddsModel
          .updateMany(
            { eventId: String(fixture.eventId), expiresAt: { $exists: false } },
            { $set: { expiresAt } },
          )
          .exec();
      }
      return 0;
    }

    // ESPN may expose completion or postponement only inside Summary status.
    // Do not price those fixtures as upcoming/live merely because the root flags
    // have not caught up yet.
    if (finishedByStatus || unavailableByStatus) {
      this.noPriceEvaluationAt.delete(String(fixture.eventId));
      await this.oddsModel
        .deleteMany({
          eventId: String(fixture.eventId),
          expiresAt: { $exists: false },
        })
        .exec();
      return 0;
    }

    const now = Date.now();
    const fixtureDate = this.toDate(fixture.fixtureDate);
    if (!fixtureDate) return 0;
    const fixturePayload = this.asRecord(fixture.payload);
    const fixtureSummary = this.asRecord(fixturePayload.summary);
    const fixtureSummaryHeader = this.asRecord(fixtureSummary.header);
    const competitionStatusParts = this.asArray(
      fixtureSummaryHeader.competitions,
    )
      .flatMap((item) => {
        const competition = this.asRecord(item);
        const status = this.asRecord(competition.status);
        const type = this.asRecord(status.type);
        return [
          status.name,
          status.detail,
          status.shortDetail,
          status.state,
          type.name,
          type.detail,
          type.shortDetail,
          type.state,
        ] as unknown[];
      })
      .filter((value) => value !== null && value !== undefined);
    const fixtureStatusParts = [
      fixture.status,
      fixture.statusDetail,
      fixture.statusShortDetail,
      ...competitionStatusParts,
    ].filter(Boolean);
    const fixtureStatusText = fixtureStatusParts.map(String).join(' ');
    const statusLooksLive =
      /(^|[^A-Z])(IN[_ -]?PROGRESS|INPROGRESS|LIVE|HALF[_ -]?TIME|FIRST[_ -]?HALF|SECOND[_ -]?HALF|STATUS_HALFTIME|STATUS_IN_PROGRESS)([^A-Z]|$)/i.test(
        fixtureStatusText,
      ) ||
      fixtureStatusParts.some((value) =>
        ['in', 'in_progress', 'in-progress'].includes(
          String(value).trim().toLowerCase(),
        ),
      );
    const fixtureIsLive = fixture.live === true || statusLooksLive;
    const nowDateWat = new Date(now + 60 * 60_000);
    const todayStartWat =
      Date.UTC(
        nowDateWat.getUTCFullYear(),
        nowDateWat.getUTCMonth(),
        nowDateWat.getUTCDate(),
      ) -
      60 * 60_000;
    const isTodayWat = fixtureDate.getTime() >= todayStartWat;
    // Today's unfinished matches and explicitly live fixtures remain eligible
    // even if scheduled kickoff has passed. Older non-live fixtures stay out of scope.
    if (!fixtureIsLive && fixtureDate.getTime() <= now && !isTodayWat) return 0;
    const status =
      `${fixture.status ?? ''} ${fixture.statusDetail ?? ''} ${fixture.statusShortDetail ?? ''}`.toLowerCase();
    if (/postpon|cancel|abandon|delay/.test(status)) {
      // Do not keep publishable prices for a fixture whose kickoff is uncertain.
      this.noPriceEvaluationAt.delete(String(fixture.eventId));
      await this.oddsModel
        .deleteMany({
          eventId: String(fixture.eventId),
          expiresAt: { $exists: false },
        })
        .exec();
      return 0;
    }
    if (fixtureDate.getTime() - now > INITIAL_ODDS_WINDOW_MS) return 0;

    const existing = (await this.oddsModel
      .find({ eventId: String(fixture.eventId), expiresAt: { $exists: false } })
      .select({
        updatedAt: 1,
        marketId: 1,
        selectionKey: 1,
        line: 1,
        decimalOdds: 1,
        priceType: 1,
        provider: 1,
        bookmaker: 1,
        providerUpdatedAt: 1,
        fairOdds: 1,
        fairOddsBasis: 1,
        marketFairOdds: 1,
        impliedProbability: 1,
        valuePercent: 1,
        oddsBasis: 1,
        oddsCalculationMethod: 1,
        predictionReady: 1,
      })
      .lean()
      .exec()) as PlainRecord[];
    const payload = this.asRecord(fixture.payload);
    const summary = this.asRecord(payload.summary);
    const teamIds = [String(fixture.homeTeamId), String(fixture.awayTeamId)];
    // Keep the freshness and pricing reads separate. Combining historical
    // fixtures into a single $facet result can exceed MongoDB's 16 MiB BSON
    // document limit when the historical fixtures contain full ESPN payloads.
    // These two queries preserve the original filters, ordering, and sample size
    // without wrapping up to 80 large payloads in one aggregate result document.
    const priorCompletedFixtureFilter = {
      completed: true,
      fixtureDate: { $lt: fixtureDate },
      $or: [{ homeTeamId: { $in: teamIds } }, { awayTeamId: { $in: teamIds } }],
    };
    const relevantHistoryUpdate = (await this.fixtureModel
      .find(priorCompletedFixtureFilter)
      .select({ _id: 0, collectedAt: 1 })
      .sort({ collectedAt: -1 })
      .limit(1)
      .lean()
      .exec()) as PlainRecord[];
    const historical = (await this.fixtureModel
      .find({
        ...priorCompletedFixtureFilter,
        homeScore: { $exists: true, $ne: null },
        awayScore: { $exists: true, $ne: null },
      })
      .select({
        eventId: 1,
        fixtureDate: 1,
        homeTeamId: 1,
        awayTeamId: 1,
        homeScore: 1,
        awayScore: 1,
        'payload.summary.boxscore.teams': 1,
        collectedAt: 1,
      })
      .sort({ fixtureDate: -1 })
      .limit(80)
      .lean()
      .exec()) as PlainRecord[];
    const sourceUpdatedAt = Math.max(
      this.toDate(payload.summaryCollectedAt)?.getTime() ?? 0,
      this.toDate(this.asRecord(summary.meta).lastUpdatedAt)?.getTime() ?? 0,
      this.toDate(fixture.fixtureCollectedAt)?.getTime() ?? 0,
      this.toDate(fixture.collectedAt)?.getTime() ?? 0,
      this.toDate(relevantHistoryUpdate[0]?.collectedAt)?.getTime() ?? 0,
      providerSourceUpdatedAt?.getTime() ?? 0,
      ...providerQuotes.map(
        (quote) => this.toDate(quote.providerUpdatedAt)?.getTime() ?? 0,
      ),
    );
    const newestPriceAt = existing.reduce(
      (latest, item) =>
        Math.max(latest, this.toDate(item.updatedAt)?.getTime() ?? 0),
      0,
    );
    const expectedKeys = this.expectedSelectionKeys(fixture);
    const existingKeys = new Set(
      existing
        .filter((item) => {
          const odds = Number(item.decimalOdds);
          return (
            Number.isFinite(odds) &&
            odds >= 1.01 &&
            odds <= MAX_DECIMAL_ODDS &&
            (item.priceType === 'PROVIDER' || item.priceType === 'ESTIMATED') &&
            [
              'BOOKMAKER_ONLY',
              'BOOKMAKER_PLUS_HISTORY',
              'HISTORICAL_ONLY',
              'PRIOR_ONLY',
            ].includes(String(item.oddsBasis)) &&
            Boolean(String(item.oddsCalculationMethod ?? '').trim()) &&
            item.predictionReady === true &&
            (item.priceType !== 'PROVIDER' ||
              this.isFreshPriceTimestamp(item.providerUpdatedAt))
          );
        })
        .map((item) =>
          this.priceKey(
            String(item.marketId),
            String(item.selectionKey),
            item.line !== undefined &&
              item.line !== null &&
              Number.isFinite(Number(item.line))
              ? Number(item.line)
              : undefined,
          ),
        ),
    );
    const completeCoverage = expectedKeys.every((key) => existingKeys.has(key));
    const summaryHasOddsData = this.hasUsableSummaryProviderOdds(fixture);
    const hasStoredEspnQuote = existing.some(
      (item) => item.priceType === 'PROVIDER' && item.provider === 'ESPN',
    );
    // Older generated estimates must not mask odds already present in Summary.
    // Force one refresh when Summary has odds but no ESPN provider quote has
    // been persisted for this fixture yet.
    if (
      completeCoverage &&
      newestPriceAt >= sourceUpdatedAt &&
      (!summaryHasOddsData || hasStoredEspnQuote)
    )
      return existing.length;
    if (
      !existing.length &&
      this.noPriceEvaluationAt.get(String(fixture.eventId)) === sourceUpdatedAt
    )
      return 0;

    // Keep known external quotes across cache expiry/restarts. Freshness wins
    // across providers so a refreshed backup quote can replace a stale primary;
    // ESPN Summary is the primary quote source; The Odds API fills missing selections.
    const preservedProviderQuotes: CanonicalProviderQuote[] = existing
      .filter(
        (item) =>
          String(item.priceType) === 'PROVIDER' &&
          Number(item.decimalOdds) >= 1.01 &&
          item.provider === 'THE_ODDS_API' &&
          this.isFreshPriceTimestamp(item.providerUpdatedAt),
      )
      .map((item) => ({
        marketId: String(item.marketId),
        selectionKey: String(item.selectionKey),
        ...(item.line !== undefined && item.line !== null
          ? { line: Number(item.line) }
          : {}),
        decimalOdds: Number(item.decimalOdds),
        provider: item.provider as 'THE_ODDS_API',
        bookmaker: String(item.bookmaker ?? item.provider ?? 'ESPN'),
        bookmakerKey: String(item.bookmaker ?? item.provider ?? 'ESPN'),
        ...(this.toDate(item.providerUpdatedAt)
          ? { providerUpdatedAt: this.toDate(item.providerUpdatedAt)! }
          : {}),
        ...(Number.isFinite(Number(item.marketFairOdds))
          ? { marketFairOdds: Number(item.marketFairOdds) }
          : {}),
      }));
    const allProviderQuotes = [...preservedProviderQuotes, ...providerQuotes];
    const prices = this.buildPrices(fixture, historical, allProviderQuotes);
    if (!prices.length) {
      this.noPriceEvaluationAt.set(String(fixture.eventId), sourceUpdatedAt);
      await this.oddsModel
        .deleteMany({
          eventId: String(fixture.eventId),
          expiresAt: { $exists: false },
        })
        .exec();
      return 0;
    }
    this.noPriceEvaluationAt.delete(String(fixture.eventId));

    // Upsert the current prices first so readers never see an empty price set
    // during a refresh. Then remove only selections no longer present.
    await this.oddsModel.bulkWrite(
      prices.map((price) => ({
        updateOne: {
          filter: {
            eventId: price.eventId,
            marketId: price.marketId,
            selectionKey: price.selectionKey,
            ...(price.line !== undefined
              ? { line: price.line }
              : { line: { $exists: false } }),
          },
          update: {
            $set: {
              decimalOdds: price.decimalOdds,
              priceType: price.priceType,
              predictionReady: this.isPredictionReadyPrice(price),
              fairOdds: price.fairOdds ?? null,
              impliedProbability: price.impliedProbability ?? null,
              valuePercent: price.valuePercent ?? null,
              ...(price.fairOddsBasis
                ? { fairOddsBasis: price.fairOddsBasis }
                : {}),
              ...(price.oddsBasis ? { oddsBasis: price.oddsBasis } : {}),
              ...(price.oddsCalculationMethod
                ? { oddsCalculationMethod: price.oddsCalculationMethod }
                : {}),
              ...(price.provider ? { provider: price.provider } : {}),
              ...(price.bookmaker ? { bookmaker: price.bookmaker } : {}),
              ...(price.providerUpdatedAt
                ? { providerUpdatedAt: price.providerUpdatedAt }
                : {}),
              ...(price.marketFairOdds !== undefined &&
              price.marketFairOdds !== null
                ? { marketFairOdds: price.marketFairOdds }
                : {}),
            },
            $unset: {
              expiresAt: 1,
              ...(!price.fairOddsBasis ? { fairOddsBasis: 1 } : {}),
              ...(!price.oddsBasis ? { oddsBasis: 1 } : {}),
              ...(!price.oddsCalculationMethod
                ? { oddsCalculationMethod: 1 }
                : {}),
              ...(!price.provider ? { provider: 1 } : {}),
              ...(!price.bookmaker ? { bookmaker: 1 } : {}),
              ...(!price.providerUpdatedAt ? { providerUpdatedAt: 1 } : {}),
              ...(price.marketFairOdds === undefined ||
              price.marketFairOdds === null
                ? { marketFairOdds: 1 }
                : {}),
            },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
    const currentSelectionFilters = prices.map((price) => ({
      marketId: price.marketId,
      selectionKey: price.selectionKey,
      ...(price.line !== undefined
        ? { line: price.line }
        : { line: { $exists: false } }),
    }));
    await this.oddsModel
      .deleteMany({
        eventId: String(fixture.eventId),
        expiresAt: { $exists: false },
        $nor: currentSelectionFilters,
      })
      .exec();
    return prices.length;
  }

  async expireCompletedFixtures(batchSize = 100): Promise<number> {
    // Walk completed fixtures in bounded _id pages instead of globally counting,
    // sorting, and paginating every odds document missing expiresAt. Also inspect
    // the newest completed fixtures every run so recent completions are handled
    // promptly while the cursor gradually backfills older records.
    const requestedBatch = Number.isFinite(batchSize)
      ? Math.max(1, Math.floor(batchSize))
      : 100;
    const newestLimit = Math.min(200, requestedBatch);
    const scanLimit = Math.min(1000, Math.max(100, requestedBatch * 5));
    const completedFilter = {
      completed: true,
      completedAt: { $exists: true, $ne: null },
      eventId: { $exists: true, $ne: null },
    };

    const scanFilter: Record<string, any> = { ...completedFilter };
    if (this.expiryFixtureCursor) {
      scanFilter._id = { $lt: this.expiryFixtureCursor };
    }

    const [newestFixtures, scannedFixtures] = await Promise.all([
      this.fixtureModel
        .find(completedFilter)
        .select({ _id: 1, eventId: 1, completedAt: 1 })
        .sort({ _id: -1 })
        .limit(newestLimit)
        .lean()
        .exec() as Promise<ExpiryFixture[]>,
      this.fixtureModel
        .find(scanFilter)
        .select({ _id: 1, eventId: 1, completedAt: 1 })
        .sort({ _id: -1 })
        .limit(scanLimit)
        .lean()
        .exec() as Promise<ExpiryFixture[]>,
    ]);

    if (!scannedFixtures.length || scannedFixtures.length < scanLimit) {
      this.expiryFixtureCursor = null;
    } else {
      this.expiryFixtureCursor =
        scannedFixtures[scannedFixtures.length - 1]._id;
    }

    const fixturesByEvent = new Map<string, PlainRecord>();
    for (const fixture of [...newestFixtures, ...scannedFixtures]) {
      const eventId = String(fixture.eventId ?? '').trim();
      if (eventId && !fixturesByEvent.has(eventId))
        fixturesByEvent.set(eventId, fixture);
    }
    const candidates = [...fixturesByEvent.values()];
    if (!candidates.length) return 0;

    // The eventId-leading index makes this a bounded lookup for just the fixture
    // batch. Only completed fixtures with odds records still missing expiresAt
    // proceed to updates; the TTL index remains responsible for deletion.
    const eventIds = candidates.map((fixture) => String(fixture.eventId));
    const pendingEventIds = new Set(
      (
        await this.oddsModel
          .distinct('eventId', {
            eventId: { $in: eventIds },
            expiresAt: { $exists: false },
          })
          .exec()
      ).map((eventId) => String(eventId)),
    );
    if (!pendingEventIds.size) return 0;

    const operations = candidates.flatMap((fixture) => {
      const eventId = String(fixture.eventId);
      if (!pendingEventIds.has(eventId)) return [];
      const completedAt = this.toDate(fixture.completedAt);
      if (!completedAt) return [];
      return [
        {
          updateMany: {
            filter: { eventId, expiresAt: { $exists: false } },
            update: {
              $set: {
                expiresAt: new Date(
                  completedAt.getTime() +
                    RETAIN_AFTER_COMPLETION_DAYS * 86_400_000,
                ),
              },
            },
          },
        },
      ];
    });
    if (!operations.length) return 0;

    const result = await this.oddsModel.bulkWrite(operations, {
      ordered: false,
    });
    return result.modifiedCount ?? 0;
  }

  private isFreshPriceTimestamp(value: unknown): boolean {
    const date = this.toDate(value);
    if (!date) return false;
    const ageMs = Date.now() - date.getTime();
    return ageMs >= -5 * 60_000 && ageMs <= 12 * 60 * 60_000;
  }

  /** The Odds module explicitly endorses only a valid, sourced, auditable value. */
  private isPredictionReadyPrice(price: Price): boolean {
    const odds = Number(price.decimalOdds);
    const validBasis = [
      'BOOKMAKER_ONLY',
      'BOOKMAKER_PLUS_HISTORY',
      'HISTORICAL_ONLY',
      'PRIOR_ONLY',
    ].includes(String(price.oddsBasis));
    const validMethod = Boolean(
      String(price.oddsCalculationMethod ?? '').trim(),
    );
    const validProvider =
      price.priceType !== 'PROVIDER' ||
      price.provider === 'ESPN' ||
      price.provider === 'THE_ODDS_API';
    // Provider prices are publishable only when their source timestamp is known
    // and current. `updatedAt` describes our database write, not the bookmaker.
    const freshProviderQuote =
      price.priceType !== 'PROVIDER' ||
      this.isFreshPriceTimestamp(price.providerUpdatedAt);
    return (
      Number.isFinite(odds) &&
      odds >= 1.01 &&
      odds <= MAX_DECIMAL_ODDS &&
      (price.priceType === 'PROVIDER' || price.priceType === 'ESTIMATED') &&
      validBasis &&
      validMethod &&
      validProvider &&
      freshProviderQuote
    );
  }

  private buildPrices(
    fixture: PlainRecord,
    historical: PlainRecord[],
    providerQuotes: CanonicalProviderQuote[] = [],
  ): Price[] {
    const eventId = String(fixture.eventId);
    const prices = new Map<string, Price>();
    let derivedOddsBasis: OddsBasis = 'HISTORICAL_ONLY';
    let derivedOddsMethod: OddsCalculationMethod = 'HISTORICAL_POISSON_MODEL';
    const providerPriority = (
      provider: StoredOddsProvider | undefined,
    ): number => {
      if (provider === 'ESPN') return 2;
      if (provider === 'THE_ODDS_API') return 1;
      return 0;
    };

    const add = (
      marketId: string,
      selectionKey: string,
      line: number | undefined,
      odds: number | null,
      priceType: CanonicalPriceType,
      metadata: PriceMetadata = {},
    ): void => {
      if (
        odds === null ||
        !Number.isFinite(odds) ||
        odds < 1.01 ||
        odds > MAX_DECIMAL_ODDS
      )
        return;
      const normalized = Number(odds.toFixed(4));
      const key = this.priceKey(marketId, selectionKey, line);
      const current = prices.get(key);

      if (priceType === 'ESTIMATED') {
        const fairBasis = metadata.fairOddsBasis ?? 'MODEL';
        const oddsBasis: OddsBasis =
          metadata.oddsBasis ??
          (fairBasis === 'PRIOR' ? 'PRIOR_ONLY' : derivedOddsBasis);
        const oddsCalculationMethod: OddsCalculationMethod =
          metadata.oddsCalculationMethod ??
          (fairBasis === 'PRIOR' ? 'GENERIC_PRIOR' : derivedOddsMethod);
        if (!current) {
          prices.set(key, {
            eventId,
            marketId,
            selectionKey,
            ...(line !== undefined ? { line } : {}),
            decimalOdds: normalized,
            priceType: 'ESTIMATED',
            fairOdds: normalized,
            fairOddsBasis: fairBasis,
            oddsBasis,
            oddsCalculationMethod,
            impliedProbability: Number((1 / normalized).toFixed(6)),
            valuePercent: null,
          });
          return;
        }
        current.fairOdds = normalized;
        current.fairOddsBasis = fairBasis;
        if (current.priceType === 'ESTIMATED') {
          current.decimalOdds = normalized;
          current.oddsBasis = oddsBasis;
          current.oddsCalculationMethod = oddsCalculationMethod;
          current.marketFairOdds = null;
          current.impliedProbability = Number((1 / normalized).toFixed(6));
          current.valuePercent = null;
        }
        return;
      }

      const incomingProvider = metadata.provider ?? 'ESPN';
      const incomingPriority = providerPriority(incomingProvider);
      const currentPriority = providerPriority(current?.provider);
      const incomingUpdatedAt =
        this.toDate(metadata.providerUpdatedAt)?.getTime() ?? 0;
      const currentUpdatedAt =
        this.toDate(current?.providerUpdatedAt)?.getTime() ?? 0;
      let shouldReplace = !current || current.priceType !== 'PROVIDER';
      if (!shouldReplace && current) {
        if (incomingPriority !== currentPriority) {
          // ESPN Summary is the declared first-choice source. The Odds API only
          // replaces it when no ESPN quote was extracted for that selection.
          shouldReplace = incomingPriority > currentPriority;
        } else if (
          incomingUpdatedAt > 0 &&
          currentUpdatedAt > 0 &&
          incomingUpdatedAt !== currentUpdatedAt
        ) {
          shouldReplace = incomingUpdatedAt > currentUpdatedAt;
        } else if (incomingUpdatedAt > 0 && currentUpdatedAt === 0) {
          shouldReplace = true;
        } else if (incomingUpdatedAt === 0 && currentUpdatedAt > 0) {
          shouldReplace = false;
        } else {
          shouldReplace = normalized > current.decimalOdds;
        }
      }

      if (shouldReplace) {
        prices.set(key, {
          eventId,
          marketId,
          selectionKey,
          ...(line !== undefined ? { line } : {}),
          decimalOdds: normalized,
          priceType: 'PROVIDER',
          ...(current?.fairOdds !== undefined
            ? { fairOdds: current.fairOdds }
            : {}),
          ...(current?.fairOddsBasis
            ? { fairOddsBasis: current.fairOddsBasis }
            : {}),
          ...(metadata.marketFairOdds !== undefined
            ? { marketFairOdds: metadata.marketFairOdds }
            : current?.marketFairOdds !== undefined
              ? { marketFairOdds: current.marketFairOdds }
              : {}),
          impliedProbability: Number((1 / normalized).toFixed(6)),
          ...(metadata.provider
            ? { provider: metadata.provider }
            : { provider: 'ESPN' }),
          ...(metadata.bookmaker ? { bookmaker: metadata.bookmaker } : {}),
          ...(metadata.providerUpdatedAt
            ? { providerUpdatedAt: metadata.providerUpdatedAt }
            : {}),
          oddsBasis: 'BOOKMAKER_ONLY',
          oddsCalculationMethod:
            metadata.oddsCalculationMethod ??
            (incomingProvider === 'ESPN'
              ? 'ESPN_SUMMARY_ODDS'
              : 'THE_ODDS_API'),
          valuePercent: null,
        });
      } else if (current && metadata.marketFairOdds !== undefined) {
        current.marketFairOdds = metadata.marketFairOdds;
      }
    };

    // ESPN Summary odds are the primary bookmaker source whenever the stored
    // odds containers are non-empty. The Odds API fills missing selections.
    const addEspn = (
      marketId: string,
      selectionKey: string,
      line: number | undefined,
      odds: number | null,
      priceType: CanonicalPriceType,
      metadata: PriceMetadata = {},
    ) =>
      add(marketId, selectionKey, line, odds, priceType, {
        provider: 'ESPN',
        ...metadata,
        oddsBasis: 'BOOKMAKER_ONLY',
      });
    this.extractProviderPrices(fixture, addEspn);
    for (const quote of providerQuotes) {
      // ESPN wins when it supplied a valid quote, regardless of timestamp.
      // The Odds API fills gaps; it never overwrites an ESPN Summary quote.
      add(
        quote.marketId,
        quote.selectionKey,
        quote.line,
        quote.decimalOdds,
        'PROVIDER',
        {
          provider: quote.provider,
          bookmaker: quote.bookmaker,
          providerUpdatedAt: quote.providerUpdatedAt,
          marketFairOdds: quote.marketFairOdds,
          oddsBasis: 'BOOKMAKER_ONLY',
          oddsCalculationMethod: 'THE_ODDS_API',
        },
      );
    }

    const matchOdds = this.getFreshMatchResultBaseline(prices);
    if (matchOdds) {
      derivedOddsBasis = 'BOOKMAKER_PLUS_HISTORY';
      derivedOddsMethod = 'BOOKMAKER_BLENDED_SCORE_MATRIX';
    }

    const homeId = String(fixture.homeTeamId);
    const awayId = String(fixture.awayTeamId);
    const homeMetrics = this.goalMetrics(historical, homeId);
    const awayMetrics = this.goalMetrics(historical, awayId);
    const expectedHome = this.expectedTeamGoals(
      homeMetrics,
      awayMetrics,
      'HOME',
    );
    const expectedAway = this.expectedTeamGoals(
      awayMetrics,
      homeMetrics,
      'AWAY',
    );

    if (expectedHome !== null && expectedAway !== null) {
      let fullTime = this.scoreMatrix(expectedHome, expectedAway);
      if (matchOdds)
        fullTime = this.blendScoreMatrixWithMarket(fullTime, matchOdds);
      const firstHalf = this.scoreMatrix(
        expectedHome * 0.45,
        expectedAway * 0.45,
      );
      const result = this.resultProbabilities(fullTime);
      const halfResult = this.resultProbabilities(firstHalf);
      const byId = new Map(
        FOOTBALL_MARKET_CATALOG.map((market) => [market.id, market]),
      );

      this.estimateStaticPrices(byId.get('MATCH_RESULT')!, result, add);
      this.estimateStaticPrices(
        byId.get('DOUBLE_CHANCE')!,
        {
          HOME_OR_DRAW: result.home + result.draw,
          DRAW_OR_AWAY: result.draw + result.away,
          HOME_OR_AWAY: result.home + result.away,
        },
        add,
      );
      const decisive = result.home + result.away;
      if (decisive > 0) {
        this.estimateStaticPrices(
          byId.get('DRAW_NO_BET')!,
          {
            HOME_DNB: result.home / decisive,
            AWAY_DNB: result.away / decisive,
          },
          add,
        );
      }
      this.estimateStaticPrices(
        byId.get('BOTH_TEAMS_TO_SCORE')!,
        {
          YES: this.matrixProbability(
            fullTime,
            (home, away) => home > 0 && away > 0,
          ),
          NO: this.matrixProbability(
            fullTime,
            (home, away) => home === 0 || away === 0,
          ),
        },
        add,
      );
      this.estimateStaticPrices(
        byId.get('HALF_TIME_RESULT')!,
        halfResult,
        add,
        {
          oddsBasis: 'HISTORICAL_ONLY',
          oddsCalculationMethod: 'HISTORICAL_POISSON_MODEL',
        },
      );

      for (const marketId of [
        'TOTAL_GOALS_OVER_UNDER',
        'HOME_TEAM_GOALS_OVER_UNDER',
        'AWAY_TEAM_GOALS_OVER_UNDER',
        'FIRST_HALF_TOTAL_GOALS',
      ]) {
        const market = byId.get(marketId);
        if (!market) continue;
        const matrix = market.period === 'FIRST_HALF' ? firstHalf : fullTime;
        for (const selection of expandCanonicalSelections(
          market,
          this.teamName(fixture, 'home'),
          this.teamName(fixture, 'away'),
        )) {
          if (selection.line === undefined) continue;
          const overProbability = this.matrixProbability(
            matrix,
            (home, away) => {
              const total =
                marketId === 'HOME_TEAM_GOALS_OVER_UNDER'
                  ? home
                  : marketId === 'AWAY_TEAM_GOALS_OVER_UNDER'
                    ? away
                    : home + away;
              return total > selection.line!;
            },
          );
          const probability = selection.key.startsWith('OVER_')
            ? overProbability
            : 1 - overProbability;
          add(
            market.id,
            selection.key,
            selection.line,
            this.fairOdds(probability),
            'ESTIMATED',
            {
              oddsBasis:
                market.period === 'FIRST_HALF'
                  ? 'HISTORICAL_ONLY'
                  : derivedOddsBasis,
              oddsCalculationMethod:
                market.period === 'FIRST_HALF'
                  ? 'HISTORICAL_POISSON_MODEL'
                  : derivedOddsMethod,
            },
          );
        }
      }

      const asian = byId.get('ASIAN_HANDICAP')!;
      for (const selection of expandCanonicalSelections(
        asian,
        this.teamName(fixture, 'home'),
        this.teamName(fixture, 'away'),
      )) {
        if (selection.handicap === undefined || !selection.side) continue;
        let win = 0;
        let loss = 0;
        for (let home = 0; home < fullTime.length; home += 1) {
          for (let away = 0; away < fullTime[home].length; away += 1) {
            const probability = fullTime[home][away];
            const difference =
              selection.side === 'HOME'
                ? home + selection.handicap - away
                : away + selection.handicap - home;
            if (difference > 0) win += probability;
            else if (difference < 0) loss += probability;
          }
        }
        add(
          asian.id,
          selection.key,
          selection.line,
          win > 0 ? Number(((win + loss) / win).toFixed(4)) : null,
          'ESTIMATED',
          {
            oddsBasis: derivedOddsBasis,
            oddsCalculationMethod: derivedOddsMethod,
          },
        );
        // Push probability is excluded from the risk ratio; a push returns the stake.
      }
    }

    this.estimateStatisticMarkets(fixture, historical, add);
    this.completeCanonicalPriceCoverage(fixture, prices, add);

    const expectedKeys = this.expectedSelectionKeys(fixture);
    const missing = expectedKeys.filter((key) => !prices.has(key));
    if (missing.length) {
      throw new Error(
        `Odds coverage incomplete for ${eventId}: ${missing.length} canonical selections have no valid price.`,
      );
    }
    for (const price of prices.values()) {
      price.impliedProbability =
        price.decimalOdds > 0
          ? Number((1 / price.decimalOdds).toFixed(6))
          : null;
      if (
        price.priceType === 'PROVIDER' &&
        price.provider !== 'ESPN' &&
        price.fairOddsBasis === 'MODEL' &&
        price.fairOdds !== undefined &&
        price.fairOdds !== null &&
        price.fairOdds > 0
      ) {
        price.valuePercent = Number(
          ((price.decimalOdds / price.fairOdds - 1) * 100).toFixed(2),
        );
      } else {
        price.valuePercent = null;
      }
    }
    return [...prices.values()];
  }

  /**
   * Prices are not prediction records. This fallback only completes the canonical
   * price book when provider quotes and fixture-specific evidence are unavailable.
   * Every fallback is labelled ESTIMATED and is never treated as independent
   * prediction evidence by the Predictions Engine.
   */
  private completeCanonicalPriceCoverage(
    fixture: PlainRecord,
    prices: Map<string, Price>,
    add: (
      marketId: string,
      selectionKey: string,
      line: number | undefined,
      odds: number | null,
      type: CanonicalPriceType,
      metadata?: PriceMetadata,
    ) => void,
  ): void {
    for (const market of FOOTBALL_MARKET_CATALOG) {
      const selections = expandCanonicalSelections(
        market,
        this.teamName(fixture, 'home'),
        this.teamName(fixture, 'away'),
      );
      for (const selection of selections) {
        const key = this.priceKey(market.id, selection.key, selection.line);
        if (prices.has(key)) continue;

        let probability = 0.5;
        if (
          market.selectionMode === 'OVER_UNDER' &&
          selection.line !== undefined
        ) {
          const mean = this.pricingPriorMean(market.id);
          const over = this.poissonOverProbability(mean, selection.line);
          probability = selection.key.startsWith('OVER_') ? over : 1 - over;
        } else if (market.selectionMode === 'STATIC') {
          probability = this.staticPricingPrior(market.id, selection.key);
        }

        // Numeric smoothing avoids impossible 1.00 prices for extreme tails.
        probability = Math.max(0.01, Math.min(0.99, probability));
        add(
          market.id,
          selection.key,
          selection.line,
          this.fairOdds(probability),
          'ESTIMATED',
          { fairOddsBasis: 'PRIOR' },
        );
      }
    }
  }

  private expectedSelectionKeys(fixture: PlainRecord): string[] {
    return FOOTBALL_MARKET_CATALOG.flatMap((market) =>
      expandCanonicalSelections(
        market,
        this.teamName(fixture, 'home'),
        this.teamName(fixture, 'away'),
      ).map((selection) =>
        this.priceKey(market.id, selection.key, selection.line),
      ),
    );
  }

  private pricingPriorMean(marketId: string): number {
    const priors: Record<string, number> = {
      TOTAL_GOALS_OVER_UNDER: 2.6,
      HOME_TEAM_GOALS_OVER_UNDER: 1.4,
      AWAY_TEAM_GOALS_OVER_UNDER: 1.2,
      FIRST_HALF_TOTAL_GOALS: 1.15,
      TOTAL_CORNERS_OVER_UNDER: 9.5,
      TOTAL_SHOTS_OVER_UNDER: 24,
      TOTAL_SHOTS_ON_TARGET_OVER_UNDER: 8.5,
      TOTAL_CARDS_OVER_UNDER: 3.5,
      TOTAL_FOULS_OVER_UNDER: 22,
      TOTAL_OFFSIDES_OVER_UNDER: 2.5,
    };
    return priors[marketId] ?? 2.5;
  }

  private staticPricingPrior(marketId: string, selectionKey: string): number {
    const priors: Record<string, Record<string, number>> = {
      MATCH_RESULT: { HOME_WIN: 0.4, DRAW: 0.28, AWAY_WIN: 0.32 },
      DOUBLE_CHANCE: {
        HOME_OR_DRAW: 0.68,
        DRAW_OR_AWAY: 0.6,
        HOME_OR_AWAY: 0.72,
      },
      DRAW_NO_BET: { HOME_DNB: 0.556, AWAY_DNB: 0.444 },
      BOTH_TEAMS_TO_SCORE: { YES: 0.5, NO: 0.5 },
      HALF_TIME_RESULT: { HOME_WIN: 0.38, DRAW: 0.38, AWAY_WIN: 0.24 },
    };
    return priors[marketId]?.[selectionKey] ?? 0.5;
  }

  private estimateStaticPrices(
    market: CanonicalMarketDefinition,
    probabilities: Record<string, number>,
    add: (
      marketId: string,
      selectionKey: string,
      line: number | undefined,
      odds: number | null,
      type: CanonicalPriceType,
      metadata?: PriceMetadata,
    ) => void,
    metadata: PriceMetadata = {},
  ): void {
    for (const selection of market.selections) {
      add(
        market.id,
        selection.key,
        undefined,
        this.fairOdds(probabilities[selection.key]),
        'ESTIMATED',
        metadata,
      );
    }
  }

  private estimateStatisticMarkets(
    fixture: PlainRecord,
    historical: PlainRecord[],
    add: (
      marketId: string,
      selectionKey: string,
      line: number | undefined,
      odds: number | null,
      type: CanonicalPriceType,
      metadata?: PriceMetadata,
    ) => void,
  ): void {
    for (const market of FOOTBALL_MARKET_CATALOG.filter(
      (item) => item.statisticKey,
    )) {
      const observations: number[] = [];
      for (const past of historical) {
        const homeStats = this.readTeamStats(past, String(past.homeTeamId));
        const awayStats = this.readTeamStats(past, String(past.awayTeamId));
        const homeValue = this.statValue(homeStats, market.statisticKey!);
        const awayValue = this.statValue(awayStats, market.statisticKey!);
        if (homeValue === null || awayValue === null) continue;
        observations.push(homeValue + awayValue);
      }
      if (observations.length < MINIMUM_STAT_SAMPLE) continue;
      const mean =
        observations.reduce((sum, value) => sum + value, 0) /
        observations.length;
      if (!Number.isFinite(mean) || mean <= 0) continue;
      for (const selection of expandCanonicalSelections(
        market,
        this.teamName(fixture, 'home'),
        this.teamName(fixture, 'away'),
      )) {
        if (selection.line === undefined) continue;
        const over = this.poissonOverProbability(mean, selection.line);
        const probability = selection.key.startsWith('OVER_') ? over : 1 - over;
        add(
          market.id,
          selection.key,
          selection.line,
          this.fairOdds(probability),
          'ESTIMATED',
          {
            oddsBasis: 'HISTORICAL_ONLY',
            oddsCalculationMethod: 'HISTORICAL_COUNT_MODEL',
          },
        );
      }
    }
  }

  private extractProviderPrices(
    fixture: PlainRecord,
    add: (
      marketId: string,
      selectionKey: string,
      line: number | undefined,
      odds: number | null,
      type: CanonicalPriceType,
      metadata?: PriceMetadata,
    ) => void,
  ): void {
    const payload = this.asRecord(fixture.payload);
    const summary = this.asRecord(payload.summary);
    const summaryDate =
      this.toDate(payload.summaryCollectedAt) ??
      this.toDate(this.asRecord(summary.meta).lastUpdatedAt);
    // A provider quote copied from Summary is only current when the Summary's
    // own source timestamp is known and fresh. fixture.collectedAt is deliberately
    // not substituted: polling a fixture must not refresh an old bookmaker quote.
    if (!summaryDate || !this.isFreshPriceTimestamp(summaryDate)) return;
    const summaryOdds = this.asRecordArray(summary.odds);
    const pickcenterOdds = this.asRecordArray(summary.pickcenter);
    const candidates: Array<{
      odds: PlainRecord;
      method: OddsCalculationMethod;
    }> = [
      ...pickcenterOdds.map((item) => ({
        odds: item,
        method: 'ESPN_PICKCENTER' as const,
      })),
      ...summaryOdds.map((item) => ({
        odds: item,
        method: 'ESPN_SUMMARY_ODDS' as const,
      })),
      ...this.asArray(payload.competitions).flatMap((item) =>
        this.asRecordArray(this.asRecord(item).odds).map((odds) => ({
          odds,
          method: 'ESPN_SUMMARY_ODDS' as const,
        })),
      ),
    ].filter((item) => Object.keys(item.odds).length > 0);

    for (const entry of candidates) {
      const odds = entry.odds;
      const providerRecord = this.asRecord(odds.provider);
      const bookmakerRecord = this.asRecord(odds.bookmaker);
      const bookmaker = String(
        providerRecord.name ??
          bookmakerRecord.name ??
          odds.bookmakerName ??
          odds.providerName ??
          'ESPN Bookmaker',
      ).trim();
      const quoteMetadata: PriceMetadata = {
        bookmaker,
        ...(summaryDate ? { providerUpdatedAt: summaryDate } : {}),
        oddsBasis: 'BOOKMAKER_ONLY',
        oddsCalculationMethod: entry.method,
      };
      const moneyline = this.asRecord(odds.moneyline ?? odds.moneyLine);
      const homeTeamOdds = this.asRecord(odds.homeTeamOdds);
      const awayTeamOdds = this.asRecord(odds.awayTeamOdds);
      const home = this.toDecimalOdds(
        moneyline.home ??
          moneyline.homeTeam ??
          homeTeamOdds.moneyLine ??
          odds.homeMoneyLine ??
          odds.homeOdds,
      );
      const draw = this.toDecimalOdds(
        moneyline.draw ??
          moneyline.tie ??
          odds.drawMoneyLine ??
          this.asRecord(odds.drawOdds).moneyLine ??
          odds.drawOdds,
      );
      const away = this.toDecimalOdds(
        moneyline.away ??
          moneyline.awayTeam ??
          awayTeamOdds.moneyLine ??
          odds.awayMoneyLine ??
          odds.awayOdds,
      );
      // Accept every valid selection independently. ESPN can return a partial
      // market, and one missing outcome must not discard the odds that exist.
      if (home !== null)
        add(
          'MATCH_RESULT',
          'HOME_WIN',
          undefined,
          home,
          'PROVIDER',
          quoteMetadata,
        );
      if (draw !== null)
        add('MATCH_RESULT', 'DRAW', undefined, draw, 'PROVIDER', quoteMetadata);
      if (away !== null)
        add(
          'MATCH_RESULT',
          'AWAY_WIN',
          undefined,
          away,
          'PROVIDER',
          quoteMetadata,
        );

      const totalLine = this.lineNumber(
        odds.overUnder ?? odds.totalLine ?? odds.totalPoints,
      );
      const over = this.toDecimalOdds(
        odds.overOdds ??
          odds.overPrice ??
          odds.totalOverOdds ??
          this.asRecord(odds.totals).over,
      );
      const under = this.toDecimalOdds(
        odds.underOdds ??
          odds.underPrice ??
          odds.totalUnderOdds ??
          this.asRecord(odds.totals).under,
      );
      const totalMarket = FOOTBALL_MARKET_CATALOG.find(
        (item) => item.id === 'TOTAL_GOALS_OVER_UNDER',
      );
      if (totalLine !== null && totalMarket?.lines?.includes(totalLine)) {
        if (over !== null) {
          add(
            totalMarket.id,
            `OVER_${canonicalLineSlug(totalLine)}`,
            totalLine,
            over,
            'PROVIDER',
            quoteMetadata,
          );
        }
        if (under !== null) {
          add(
            totalMarket.id,
            `UNDER_${canonicalLineSlug(totalLine)}`,
            totalLine,
            under,
            'PROVIDER',
            quoteMetadata,
          );
        }
      }

      const homeSpread = this.lineNumber(
        homeTeamOdds.spread ?? odds.homeSpread ?? odds.spread,
      );
      const awaySpread = this.lineNumber(
        awayTeamOdds.spread ?? odds.awaySpread,
      );
      const homeSpreadOdds = this.toDecimalOdds(
        homeTeamOdds.spreadOdds ?? odds.homeSpreadOdds,
      );
      const awaySpreadOdds = this.toDecimalOdds(
        awayTeamOdds.spreadOdds ?? odds.awaySpreadOdds,
      );
      const handicapMarket = FOOTBALL_MARKET_CATALOG.find(
        (item) => item.id === 'ASIAN_HANDICAP',
      );
      if (handicapMarket?.lines) {
        if (
          homeSpread !== null &&
          handicapMarket.lines.includes(homeSpread) &&
          homeSpreadOdds !== null
        ) {
          add(
            handicapMarket.id,
            `HOME_${canonicalLineSlug(homeSpread)}`,
            homeSpread,
            homeSpreadOdds,
            'PROVIDER',
            quoteMetadata,
          );
        }
        if (
          awaySpread !== null &&
          handicapMarket.lines.includes(awaySpread) &&
          awaySpreadOdds !== null
        ) {
          add(
            handicapMarket.id,
            `AWAY_${canonicalLineSlug(awaySpread)}`,
            awaySpread,
            awaySpreadOdds,
            'PROVIDER',
            quoteMetadata,
          );
        }
      }
    }
  }

  private getFreshMatchResultBaseline(
    prices: Map<string, Price>,
  ): { home: number; draw: number; away: number } | null {
    const home = prices.get(this.priceKey('MATCH_RESULT', 'HOME_WIN'));
    const draw = prices.get(this.priceKey('MATCH_RESULT', 'DRAW'));
    const away = prices.get(this.priceKey('MATCH_RESULT', 'AWAY_WIN'));
    const quotes = [home, draw, away];
    if (
      quotes.some(
        (quote) =>
          !quote ||
          quote.priceType !== 'PROVIDER' ||
          (quote.provider !== 'ESPN' &&
            !this.isFreshPriceTimestamp(quote.providerUpdatedAt)),
      )
    )
      return null;
    const values = quotes.map((quote) => Number(quote!.decimalOdds));
    if (values.some((value) => !Number.isFinite(value) || value <= 1))
      return null;
    const implied = values.map((value) => 1 / value);
    const total = implied.reduce((sum, value) => sum + value, 0);
    if (!Number.isFinite(total) || total <= 0) return null;
    return {
      home: implied[0] / total,
      draw: implied[1] / total,
      away: implied[2] / total,
    };
  }

  /** Reconciles the historical score matrix toward fresh 1X2 bookmaker probabilities. */
  private blendScoreMatrixWithMarket(
    matrix: number[][],
    market: { home: number; draw: number; away: number },
  ): number[][] {
    const current = this.resultProbabilities(matrix);
    const weight = 0.25;
    const target = {
      home: current.home * (1 - weight) + market.home * weight,
      draw: current.draw * (1 - weight) + market.draw * weight,
      away: current.away * (1 - weight) + market.away * weight,
    };
    const total = target.home + target.draw + target.away;
    if (!(total > 0)) return matrix;
    target.home /= total;
    target.draw /= total;
    target.away /= total;
    return matrix.map((row, homeGoals) =>
      row.map((probability, awayGoals) => {
        const oldClass =
          homeGoals > awayGoals
            ? current.home
            : homeGoals === awayGoals
              ? current.draw
              : current.away;
        const targetClass =
          homeGoals > awayGoals
            ? target.home
            : homeGoals === awayGoals
              ? target.draw
              : target.away;
        return oldClass > 0
          ? probability * (targetClass / oldClass)
          : probability;
      }),
    );
  }

  private goalMetrics(historical: PlainRecord[], teamId: string): GoalMetrics {
    const values = {
      scored: [] as number[],
      conceded: [] as number[],
      homeScored: [] as number[],
      homeConceded: [] as number[],
      awayScored: [] as number[],
      awayConceded: [] as number[],
    };
    for (const match of historical) {
      const homeScore = this.finiteNumber(match.homeScore);
      const awayScore = this.finiteNumber(match.awayScore);
      if (homeScore === null || awayScore === null) continue;
      if (String(match.homeTeamId) === teamId) {
        values.scored.push(homeScore);
        values.conceded.push(awayScore);
        values.homeScored.push(homeScore);
        values.homeConceded.push(awayScore);
      } else if (String(match.awayTeamId) === teamId) {
        values.scored.push(awayScore);
        values.conceded.push(homeScore);
        values.awayScored.push(awayScore);
        values.awayConceded.push(homeScore);
      }
    }
    return values;
  }

  private expectedTeamGoals(
    team: GoalMetrics,
    opponent: GoalMetrics,
    side: 'HOME' | 'AWAY',
  ): number | null {
    const scored = side === 'HOME' ? team.homeScored : team.awayScored;
    const conceded =
      side === 'HOME' ? opponent.awayConceded : opponent.homeConceded;
    const allScored = team.scored;
    const allConceded = opponent.conceded;
    const scoreSamples =
      scored.length >= MINIMUM_STAT_SAMPLE ? scored : allScored;
    const concedeSamples =
      conceded.length >= MINIMUM_STAT_SAMPLE ? conceded : allConceded;
    if (
      scoreSamples.length < MINIMUM_STAT_SAMPLE ||
      concedeSamples.length < MINIMUM_STAT_SAMPLE
    )
      return null;
    const avg = (values: number[]) =>
      values.reduce((sum, value) => sum + value, 0) / values.length;
    return Math.max(
      0.05,
      Math.min(5.5, (avg(scoreSamples) + avg(concedeSamples)) / 2),
    );
  }

  private scoreMatrix(homeMean: number, awayMean: number): number[][] {
    const home = this.poissonDistribution(homeMean, MAX_GOALS);
    const away = this.poissonDistribution(awayMean, MAX_GOALS);
    const matrix = home.map((probability) =>
      away.map((other) => probability * other),
    );
    const total = matrix
      .flat()
      .reduce((sum, probability) => sum + probability, 0);
    return total > 0
      ? matrix.map((row) => row.map((probability) => probability / total))
      : matrix;
  }

  private resultProbabilities(matrix: number[][]): {
    HOME_WIN: number;
    DRAW: number;
    AWAY_WIN: number;
    home: number;
    draw: number;
    away: number;
  } {
    let home = 0;
    let draw = 0;
    let away = 0;
    for (let h = 0; h < matrix.length; h += 1) {
      for (let a = 0; a < matrix[h].length; a += 1) {
        if (h > a) home += matrix[h][a];
        else if (h === a) draw += matrix[h][a];
        else away += matrix[h][a];
      }
    }
    return { HOME_WIN: home, DRAW: draw, AWAY_WIN: away, home, draw, away };
  }

  private matrixProbability(
    matrix: number[][],
    predicate: (home: number, away: number) => boolean,
  ): number {
    let probability = 0;
    for (let home = 0; home < matrix.length; home += 1)
      for (let away = 0; away < matrix[home].length; away += 1)
        if (predicate(home, away)) probability += matrix[home][away];
    return Math.max(0, Math.min(1, probability));
  }

  private poissonDistribution(mean: number, max: number): number[] {
    const lambda = Math.max(0.0001, Math.min(80, mean));
    const values: number[] = [Math.exp(-lambda)];
    for (let i = 1; i <= max; i += 1) values.push((values[i - 1] * lambda) / i);
    const sum = values.reduce((total, value) => total + value, 0);
    return sum > 0 ? values.map((value) => value / sum) : values;
  }

  private poissonOverProbability(mean: number, line: number): number {
    const distribution = this.poissonDistribution(
      mean,
      Math.max(60, Math.ceil(mean + 8 * Math.sqrt(mean + 1))),
    );
    const threshold = Math.floor(line);
    return Math.max(
      0,
      Math.min(
        1,
        1 -
          distribution
            .slice(0, threshold + 1)
            .reduce((sum, value) => sum + value, 0),
      ),
    );
  }

  private fairOdds(probability: number | undefined): number | null {
    if (
      probability === undefined ||
      !Number.isFinite(probability) ||
      probability <= 0 ||
      probability > 1
    )
      return null;
    const odds = 1 / probability;
    if (!Number.isFinite(odds) || odds < 1.01 || odds > MAX_DECIMAL_ODDS)
      return null;
    return Number(odds.toFixed(4));
  }

  private readTeamStats(fixture: PlainRecord, teamId: string): TeamStats {
    const payload = this.asRecord(fixture.payload);
    const summary = this.asRecord(payload.summary);
    const boxscore = this.asRecord(summary.boxscore);
    const teams = this.asArray(boxscore.teams);
    const selected = teams.find(
      (entry) =>
        String(
          this.asRecord(this.asRecord(entry).team).id ??
            this.asRecord(entry).teamId ??
            '',
        ) === teamId,
    );
    const output: TeamStats = {};
    for (const item of this.asArray(this.asRecord(selected).statistics)) {
      const stat = this.asRecord(item);
      const value = this.finiteNumber(stat.displayValue ?? stat.value);
      if (value === null) continue;
      for (const rawKey of [
        stat.name,
        stat.abbreviation,
        stat.label,
        stat.displayName,
      ]) {
        if (typeof rawKey !== 'string') continue;
        output[rawKey.toLowerCase().replace(/[^a-z0-9]/g, '')] = value;
      }
    }
    if (Object.keys(output).length) return output;
    for (const competition of this.asArray(payload.competitions)) {
      const competitors = this.asArray(this.asRecord(competition).competitors);
      const competitor = competitors.find(
        (entry) => String(this.asRecord(entry).id ?? '') === teamId,
      );
      for (const item of this.asArray(this.asRecord(competitor).statistics)) {
        const stat = this.asRecord(item);
        const key = String(stat.name ?? stat.abbreviation ?? '')
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '');
        const value = this.finiteNumber(stat.displayValue ?? stat.value);
        if (key && value !== null) output[key] = value;
      }
    }
    return output;
  }

  private statValue(
    stats: TeamStats,
    statistic: NonNullable<CanonicalMarketDefinition['statisticKey']>,
  ): number | null {
    const read = (...keys: string[]): number | null => {
      for (const key of keys) {
        const value = stats[key.toLowerCase().replace(/[^a-z0-9]/g, '')];
        if (Number.isFinite(value)) return value;
      }
      return null;
    };
    switch (statistic) {
      case 'corners':
        return read('wonCorners', 'cornerKicks', 'totalCorners', 'corners');
      case 'shots':
        return read('totalShots', 'shots', 'totalShotsAttempted');
      case 'shotsOnTarget':
        return read('shotsOnTarget', 'shotsOnGoal', 'onGoal', 'sot');
      case 'cards': {
        const yellow = read('yellowCards', 'yellowCard');
        const red = read('redCards', 'redCard');
        return yellow !== null && red !== null ? yellow + red : null;
      }
      case 'fouls':
        return read('foulsCommitted', 'fouls', 'foul');
      case 'offsides':
        return read('offsides', 'offside');
    }
  }

  private teamName(fixture: PlainRecord, side: 'home' | 'away'): string {
    const payload = this.asRecord(fixture.payload);
    const competitors = this.asArray(
      this.asRecord(this.asArray(payload.competitions)[0]).competitors,
    );
    const competitor = competitors.find(
      (item) =>
        String(this.asRecord(item).homeAway ?? '').toLowerCase() === side,
    );
    const team = this.asRecord(this.asRecord(competitor).team);
    return String(
      team.displayName ??
        team.name ??
        (side === 'home' ? 'Home Team' : 'Away Team'),
    );
  }

  private toDecimalOdds(value: unknown): number | null {
    if (typeof value === 'string') {
      const trimmed = value.trim().toUpperCase();
      if (!trimmed || ['N/A', 'EVEN', 'EVS', '-'].includes(trimmed))
        return ['EVEN', 'EVS'].includes(trimmed) ? 2 : null;
      const number = Number(trimmed.replace(/,/g, ''));
      if (!Number.isFinite(number)) return null;
      if (trimmed.startsWith('+'))
        return number > 0 ? Number((1 + number / 100).toFixed(4)) : null;
      return this.toDecimalOdds(number);
    }
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value === 0 ||
      value === 1
    )
      return null;
    if (value < 0) return Number((1 + 100 / Math.abs(value)).toFixed(4));
    if (Number.isInteger(value) && value >= 10)
      return Number((1 + value / 100).toFixed(4));
    return value >= 1.01 && value <= MAX_DECIMAL_ODDS
      ? Number(value.toFixed(4))
      : null;
  }

  private lineNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value.trim());
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  private priceKey(
    marketId: string,
    selectionKey: string,
    line?: number,
  ): string {
    return `${marketId}:${selectionKey}:${line === undefined ? '-' : line}`;
  }

  private asRecord(value: unknown): PlainRecord {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value
      : {};
  }

  private asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
  }

  private asRecordArray(value: unknown): PlainRecord[] {
    const values = Array.isArray(value) ? value : [value];
    return values
      .map((item) => this.asRecord(item))
      .filter((item) => Object.keys(item).length > 0);
  }

  private finiteNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'string' || !value.trim()) return null;
    const parsed = Number(value.replace(/,/g, '').replace(/%$/, '').trim());
    return Number.isFinite(parsed) ? parsed : null;
  }

  private toDate(value: unknown): Date | null {
    if (value instanceof Date && Number.isFinite(value.getTime())) return value;
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }
}
