import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  BET_LAB_MARKET_BY_CODE,
  BET_LAB_MARKET_CATALOG,
  expandMarketSelections,
} from '../catalog/bet-lab-market-catalog';
import { BetLabMarketCode } from '../enums/bet-lab-market-code.enum';
import { BetLabOddsSource } from '../enums/bet-lab-odds-source.enum';
import type {
  BetLabOddsTimestampBasis,
  BetLabPriceType,
} from '../enums/bet-lab-odds-source.enum';
import { BET_LAB_CONFIG } from '../config/bet-lab.config';
import {
  BetLabFixtureIdentity,
  BetLabMarketQuote,
  BetLabSelectionRequest,
  BetLabMarketWithQuotes,
  BetLabSelectionQuote,
} from '../interfaces/bet-lab-market.interface';
import { EspnFixture } from '../../sports/schemas/espn/espn-fixture.schema';
import { EspnLeague } from '../../sports/schemas/espn/espn-league.schema';
import { OddsReadService } from '../../odds/services/odds-read.service';
import {
  FOOTBALL_MARKET_BY_ID,
  FOOTBALL_MARKET_BY_BET_LAB_CODE,
} from '../../odds/catalog/football-market-catalog';
import {
  asRecord,
  extractFixtureIdentity,
  extractRosterPlayers,
} from '../utils/fixture.util';

interface StoredOddsPrice {
  eventId: unknown;
  marketId: unknown;
  decimalOdds: unknown;
  updatedAt: unknown;
  oddsCapturedAt?: unknown;
  oddsFreshUntil?: unknown;
  isFresh?: unknown;
  predictionReady?: unknown;
  selectionKey: unknown;
  line?: unknown;
  priceType: unknown;
  provider?: unknown;
  bookmaker?: unknown;
  providerUpdatedAt?: unknown;
  fairOdds?: unknown;
  marketFairOdds?: unknown;
  oddsBasis?: unknown;
  oddsCalculationMethod?: unknown;
}

interface ResolvedStoredPrice {
  decimalOdds: number;
  oddsSource: BetLabOddsSource;
  priceType: BetLabPriceType;
  bookmaker: string | null;
  providerUpdatedAt: Date | null;
  oddsTimestampBasis: BetLabOddsTimestampBasis;
  oddsCapturedAt: Date;
  oddsFreshUntil: Date | null;
  isFresh: boolean;
  oddsBasis:
    | 'BOOKMAKER_ONLY'
    | 'BOOKMAKER_PLUS_HISTORY'
    | 'HISTORICAL_ONLY'
    | 'PRIOR_ONLY'
    | null;
  oddsCalculationMethod: string | null;
}

interface FixturePricingSnapshot {
  oddsCapturedAt: Date | null;
  oddsFreshUntil: Date | null;
  markets: BetLabMarketWithQuotes[];
}

function asStoredOddsPrices(value: unknown): StoredOddsPrice[] {
  return Array.isArray(value) ? (value as StoredOddsPrice[]) : [];
}

@Injectable()
export class BetLabMarketService {
  /** Coalesce concurrent pricing reads for the same fixture (e.g. accumulator legs). */
  private readonly pricingInFlight = new Map<
    string,
    Promise<FixturePricingSnapshot>
  >();

  constructor(
    @InjectModel(EspnFixture.name)
    private readonly fixtureModel: Model<EspnFixture>,
    @InjectModel(EspnLeague.name)
    private readonly leagueModel: Model<EspnLeague>,
    private readonly oddsService: OddsReadService,
  ) {}

  async listFixtures(
    query: {
      from?: string;
      to?: string;
      leagueId?: string;
      teamId?: string;
      page?: number;
      limit?: number;
    } = {},
  ) {
    const now = new Date();
    const defaultEnd = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
    const from = query.from ? this.parseDate(query.from, 'from') : now;
    const to = query.to ? this.parseDate(query.to, 'to') : defaultEnd;
    if (to <= from) throw new BadRequestException('to must be later than from');
    const maxWindowMs = 90 * 24 * 60 * 60 * 1000;
    if (to.getTime() - from.getTime() > maxWindowMs) {
      throw new BadRequestException(
        'Fixture query range cannot exceed 90 days',
      );
    }

    const page = Math.max(1, Math.floor(Number(query.page) || 1));
    const limit = Math.min(
      100,
      Math.max(1, Math.floor(Number(query.limit) || 20)),
    );
    const filter: Record<string, unknown> = {
      fixtureDate: { $gte: from, $lt: to },
      completed: { $ne: true },
      $nor: [
        {
          status:
            /FINAL|FINISHED|FULL[_ -]?TIME|\bFT\b|\bAET\b|\bPEN\b|POSTPON|\bPST\b|CANCEL|\bCANC\b|ABANDON|SUSPEND|INTERRUPT|DELAY|VOID|NO[_ -]?CONTEST/i,
        },
        {
          statusDetail:
            /FINAL|FINISHED|FULL[_ -]?TIME|\bFT\b|\bAET\b|\bPEN\b|POSTPON|\bPST\b|CANCEL|\bCANC\b|ABANDON|SUSPEND|INTERRUPT|DELAY|VOID|NO[_ -]?CONTEST/i,
        },
        {
          statusShortDetail:
            /FINAL|FINISHED|FULL[_ -]?TIME|\bFT\b|\bAET\b|\bPEN\b|POSTPON|\bPST\b|CANCEL|\bCANC\b|ABANDON|SUSPEND|INTERRUPT|DELAY|VOID|NO[_ -]?CONTEST/i,
        },
      ],
    };
    if (query.leagueId?.trim())
      filter.leagueId = query.leagueId.trim().toLowerCase();
    if (query.teamId?.trim()) {
      filter.$or = [
        { homeTeamId: query.teamId.trim() },
        { awayTeamId: query.teamId.trim() },
      ];
    }

    const [fixtures, total] = await Promise.all([
      this.fixtureModel
        .find(filter)
        .sort({ fixtureDate: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select({
          eventId: 1,
          leagueId: 1,
          fixtureDate: 1,
          status: 1,
          statusDetail: 1,
          statusShortDetail: 1,
          live: 1,
          completed: 1,
          homeTeamId: 1,
          awayTeamId: 1,
          venueName: 1,
          collectedAt: 1,
          'payload.name': 1,
          'payload.league': 1,
          'payload.venue': 1,
          'payload.competitions.id': 1,
          'payload.competitions.name': 1,
          'payload.competitions.shortName': 1,
          'payload.competitions.altGameNote': 1,
          'payload.competitions.notes': 1,
          'payload.competitions.venue': 1,
          'payload.competitions.competitors.id': 1,
          'payload.competitions.competitors.homeAway': 1,
          'payload.competitions.competitors.team': 1,
          'payload.summary.rosters': 1,
          'payload.summaryCollectedAt': 1,
        })
        .lean()
        .exec(),
      this.fixtureModel.countDocuments(filter).exec(),
    ]);

    const leagueIds = [
      ...new Set(
        fixtures.map((fixture) => String(fixture.leagueId).toLowerCase()),
      ),
    ];
    const leagueRows = leagueIds.length
      ? await this.leagueModel
          .find({ leagueId: { $in: leagueIds } })
          .select({ leagueId: 1, name: 1, abbreviation: 1 })
          .lean()
          .exec()
      : [];
    const leagueNames = new Map<string, string>(
      leagueRows.map((league) => [
        String(league.leagueId).toLowerCase(),
        String(league.name),
      ]),
    );
    const storedPrices = asStoredOddsPrices(
      await this.oddsService.getPricesForFixtures(
        fixtures.map((fixture) => extractFixtureIdentity(fixture).eventId),
      ),
    );
    const storedCountByEvent = new Map<string, number>();
    for (const price of storedPrices) {
      const resolved = this.resolveStoredPrice(price);
      if (!resolved) continue;
      if (!resolved.isFresh) continue;
      const eventId = String(price.eventId);
      storedCountByEvent.set(
        eventId,
        (storedCountByEvent.get(eventId) ?? 0) + 1,
      );
    }

    return {
      items: fixtures.map((fixture) => {
        const identity = extractFixtureIdentity(fixture);
        identity.leagueName =
          leagueNames.get(identity.leagueId.toLowerCase()) ??
          identity.leagueName;
        const summary = asRecord(identity.payload.summary);
        const storedCount = storedCountByEvent.get(identity.eventId) ?? 0;
        return {
          eventId: identity.eventId,
          leagueId: identity.leagueId,
          leagueName: identity.leagueName,
          fixtureDate: identity.fixtureDate,
          status: identity.status,
          live: identity.live,
          completed: identity.completed,
          homeTeam: {
            id: identity.homeTeamId,
            name: identity.homeTeamName,
          },
          awayTeam: {
            id: identity.awayTeamId,
            name: identity.awayTeamName,
          },
          venueName: identity.venueName,
          hasSummary: Boolean(summary && Object.keys(summary).length > 0),
          hasPricedSelections: storedCount > 0,
          pricedSelectionCount: storedCount,
          summaryCollectedAt: identity.summaryCollectedAt,
        };
      }),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async getFixtureIdentity(
    eventId: string,
    requireUpcoming = true,
  ): Promise<BetLabFixtureIdentity> {
    const normalizedId = String(eventId ?? '').trim();
    if (!normalizedId) throw new BadRequestException('eventId is required');
    const fixture = await this.fixtureModel
      .findOne({ eventId: normalizedId })
      .select({
        eventId: 1,
        leagueId: 1,
        fixtureDate: 1,
        status: 1,
        statusDetail: 1,
        statusShortDetail: 1,
        live: 1,
        completed: 1,
        homeTeamId: 1,
        awayTeamId: 1,
        venueName: 1,
        collectedAt: 1,
        'payload.name': 1,
        'payload.league': 1,
        'payload.venue': 1,
        'payload.competitions.id': 1,
        'payload.competitions.name': 1,
        'payload.competitions.shortName': 1,
        'payload.competitions.altGameNote': 1,
        'payload.competitions.notes': 1,
        'payload.competitions.venue': 1,
        'payload.competitions.competitors.id': 1,
        'payload.competitions.competitors.homeAway': 1,
        'payload.competitions.competitors.team': 1,
        'payload.competitions.odds': 1,
        'payload.summary.pickcenter': 1,
        'payload.summary.odds': 1,
        'payload.summary.rosters': 1,
        'payload.summaryCollectedAt': 1,
      })
      .lean()
      .exec();
    if (!fixture)
      throw new NotFoundException(`Fixture ${normalizedId} was not found`);
    const identity = extractFixtureIdentity(fixture);
    const league = await this.leagueModel
      .findOne({ leagueId: identity.leagueId })
      .select({ leagueId: 1, name: 1 })
      .lean()
      .exec();
    if (league?.name) identity.leagueName = String(league.name);
    if (requireUpcoming) this.assertPlaceableFixture(identity);
    return identity;
  }

  getMarketCatalog() {
    const context = {
      homeTeamName: 'Home Team',
      awayTeamName: 'Away Team',
      players: [] as Array<{ id: string; name: string; abbreviation: string }>,
    };
    return BET_LAB_MARKET_CATALOG.map((market) => ({
      code: market.code,
      jsonVariable: market.jsonVariable,
      fullName: market.fullName,
      abbreviation: market.abbreviation,
      category: market.category,
      period: market.period,
      selectionMode: market.selectionMode,
      selections: expandMarketSelections(market, context),
      lines: market.lines ?? [],
      // The active Odds catalogue contains no player market groups. Keep the
      // response field for older clients without exposing an unsupported template.
      selectionTemplate: undefined,
      notes: market.notes,
      dynamicSelections: market.selectionMode !== 'STATIC',
    }));
  }

  async getMarketsForFixture(eventId: string): Promise<{
    fixture: Pick<
      BetLabFixtureIdentity,
      | 'eventId'
      | 'leagueId'
      | 'leagueName'
      | 'fixtureDate'
      | 'homeTeamId'
      | 'homeTeamName'
      | 'awayTeamId'
      | 'awayTeamName'
    >;
    oddsMode: 'VIRTUAL_GAME';
    oddsCapturedAt: Date | null;
    oddsFreshUntil: Date | null;
    markets: BetLabMarketWithQuotes[];
  }> {
    const fixture = await this.getFixtureIdentity(eventId, true);
    const pricing = await this.buildMarketPricing(fixture);
    return {
      fixture: {
        eventId: fixture.eventId,
        leagueId: fixture.leagueId,
        leagueName: fixture.leagueName,
        fixtureDate: fixture.fixtureDate,
        homeTeamId: fixture.homeTeamId,
        homeTeamName: fixture.homeTeamName,
        awayTeamId: fixture.awayTeamId,
        awayTeamName: fixture.awayTeamName,
      },
      oddsMode: 'VIRTUAL_GAME',
      ...pricing,
    };
  }

  async getSelectionQuote(
    eventId: string,
    marketCode: BetLabMarketCode,
    selectionCode: string,
  ): Promise<BetLabMarketQuote> {
    const quotes = await this.getSelectionQuotes([
      { eventId, marketCode, selectionCode },
    ]);
    const quote = quotes[0];
    if (!quote) {
      throw new NotFoundException(
        'The requested Bet Lab selection could not be resolved.',
      );
    }
    return quote;
  }

  /**
   * Resolve one or many ticket quotes with bounded database round trips.
   * Accumulator placement uses one fixture read, one league read and one Odds
   * read for the complete slip instead of three reads per leg.
   */
  async getSelectionQuotes(
    requests: BetLabSelectionRequest[],
  ): Promise<BetLabMarketQuote[]> {
    if (!requests.length) return [];

    const normalizedRequests = requests.map((request) => ({
      ...request,
      eventId: String(request.eventId ?? '').trim(),
      selectionCode: String(request.selectionCode ?? '').trim(),
    }));
    if (
      normalizedRequests.some(
        (request) => !request.eventId || !request.selectionCode,
      )
    ) {
      throw new BadRequestException(
        'Every selection must include a fixture and selection code.',
      );
    }

    const eventIds = [
      ...new Set(normalizedRequests.map((request) => request.eventId)),
    ];
    const fixtures = await this.fixtureModel
      .find({ eventId: { $in: eventIds } })
      .select({
        eventId: 1,
        leagueId: 1,
        fixtureDate: 1,
        status: 1,
        statusDetail: 1,
        statusShortDetail: 1,
        live: 1,
        completed: 1,
        homeTeamId: 1,
        awayTeamId: 1,
        venueName: 1,
        collectedAt: 1,
        'payload.name': 1,
        'payload.league': 1,
        'payload.venue': 1,
        'payload.competitions.id': 1,
        'payload.competitions.name': 1,
        'payload.competitions.shortName': 1,
        'payload.competitions.altGameNote': 1,
        'payload.competitions.notes': 1,
        'payload.competitions.venue': 1,
        'payload.competitions.competitors.id': 1,
        'payload.competitions.competitors.homeAway': 1,
        'payload.competitions.competitors.team': 1,
        'payload.summary.rosters': 1,
        'payload.summaryCollectedAt': 1,
      })
      .lean()
      .exec();

    const fixtureByEventId = new Map<string, BetLabFixtureIdentity>();
    const leagueIds = new Set<string>();
    for (const fixture of fixtures) {
      const identity = extractFixtureIdentity(fixture);
      this.assertPlaceableFixture(identity);
      fixtureByEventId.set(identity.eventId, identity);
      if (identity.leagueId) leagueIds.add(identity.leagueId);
    }

    const missingEventId = eventIds.find(
      (eventId) => !fixtureByEventId.has(eventId),
    );
    if (missingEventId) {
      throw new NotFoundException(`Fixture ${missingEventId} was not found`);
    }

    // Resolve requested selections from the canonical Odds catalogue first.
    // Placement reads only those exact quotes; it does not build all 16 markets
    // or transfer hundreds of irrelevant lines for each fixture.
    const requested = normalizedRequests.map((request) => {
      const fixture = fixtureByEventId.get(request.eventId)!;
      const market = BET_LAB_MARKET_BY_CODE.get(request.marketCode);
      const canonicalMarket = FOOTBALL_MARKET_BY_BET_LAB_CODE.get(
        String(request.marketCode),
      );
      if (!market || !canonicalMarket) {
        throw new BadRequestException(
          `Unsupported market code: ${request.marketCode}`,
        );
      }
      const selection = expandMarketSelections(market, {
        homeTeamName: fixture.homeTeamName,
        awayTeamName: fixture.awayTeamName,
      }).find((item) => item.code === request.selectionCode);
      if (!selection) {
        throw new BadRequestException(
          'Unknown market or selection for this fixture',
        );
      }
      return { ...request, fixture, market, canonicalMarket, selection };
    });

    const [leagueRows, storedPrices] = await Promise.all([
      leagueIds.size
        ? this.leagueModel
            .find({ leagueId: { $in: [...leagueIds] } })
            .select({ leagueId: 1, name: 1 })
            .lean()
            .exec()
        : Promise.resolve([]),
      this.oddsService.getPricesForSelections(
        requested.map((item) => ({
          eventId: item.eventId,
          marketId: item.canonicalMarket.id,
          selectionKey: item.selection.code,
          ...(item.selection.line !== undefined
            ? { line: item.selection.line }
            : {}),
        })),
      ),
    ]);

    const leagueNameById = new Map<string, string>();
    for (const league of leagueRows as unknown as Array<{
      leagueId: unknown;
      name?: unknown;
    }>) {
      leagueNameById.set(
        String(league.leagueId).toLowerCase(),
        typeof league.name === 'string' ? league.name : '',
      );
    }
    for (const identity of fixtureByEventId.values()) {
      const leagueName = leagueNameById.get(identity.leagueId.toLowerCase());
      if (leagueName) identity.leagueName = leagueName;
    }

    const priceByKey = new Map<string, StoredOddsPrice>();
    for (const price of asStoredOddsPrices(storedPrices)) {
      const key = this.exactPriceKey(
        String(price.eventId),
        String(price.marketId),
        String(price.selectionKey),
        price.line === undefined || price.line === null
          ? undefined
          : Number(price.line),
      );
      priceByKey.set(key, price);
    }

    return requested.map((item) => {
      const stored = priceByKey.get(
        this.exactPriceKey(
          item.eventId,
          item.canonicalMarket.id,
          item.selection.code,
          item.selection.line,
        ),
      );
      const resolved = stored ? this.resolveStoredPrice(stored) : null;
      if (!resolved || !resolved.isFresh) {
        throw new ConflictException(
          stored
            ? 'The Odds module has marked this stored price stale or unusable; the selection cannot be placed.'
            : 'No Odds-module-approved stored price exists for this exact selection.',
        );
      }
      return this.toSelectionQuote(
        item.fixture,
        item.market,
        item.selection,
        resolved,
      );
    });
  }

  private toSelectionQuote(
    fixture: BetLabFixtureIdentity,
    definition: NonNullable<ReturnType<typeof BET_LAB_MARKET_BY_CODE.get>>,
    selection: ReturnType<typeof expandMarketSelections>[number],
    price: ResolvedStoredPrice,
  ): BetLabMarketQuote {
    return {
      fixture,
      market: {
        code: definition.code,
        jsonVariable: definition.jsonVariable,
        fullName: definition.fullName,
        abbreviation: definition.abbreviation,
      },
      selection: {
        code: selection.code,
        jsonVariable: selection.jsonVariable,
        fullName: selection.fullName,
        abbreviation: selection.abbreviation,
        settlementKey: selection.settlementKey,
        line: selection.line,
        handicap: selection.handicap,
        homeGoals: selection.homeGoals,
        awayGoals: selection.awayGoals,
        subjectId: selection.subjectId,
        subjectName: selection.subjectName,
        subjectAbbreviation: selection.subjectAbbreviation,
        subjectTeamId: selection.subjectTeamId,
      },
      decimalOdds: price.decimalOdds,
      oddsSource: price.oddsSource,
      priceType: price.priceType,
      bookmaker: price.bookmaker,
      providerUpdatedAt: price.providerUpdatedAt,
      oddsTimestampBasis: price.oddsTimestampBasis,
      oddsCapturedAt: price.oddsCapturedAt,
      oddsBasis: price.oddsBasis,
      oddsCalculationMethod: price.oddsCalculationMethod,
    };
  }

  private exactPriceKey(
    eventId: string,
    marketId: string,
    selectionKey: string,
    line?: number,
  ): string {
    return `${eventId}:${marketId}:${selectionKey}:${line === undefined ? '-' : line}`;
  }

  private buildMarketPricing(
    fixture: BetLabFixtureIdentity,
  ): Promise<FixturePricingSnapshot> {
    const eventId = String(fixture.eventId);
    const existing = this.pricingInFlight.get(eventId);
    if (existing) return existing;

    const pending = this.buildMarketPricingFromStore(fixture);
    this.pricingInFlight.set(eventId, pending);
    void pending
      .finally(() => {
        if (this.pricingInFlight.get(eventId) === pending) {
          this.pricingInFlight.delete(eventId);
        }
      })
      .catch(() => undefined);
    return pending;
  }

  private async buildMarketPricingFromStore(
    fixture: BetLabFixtureIdentity,
    preloadedPrices?: StoredOddsPrice[],
  ): Promise<FixturePricingSnapshot> {
    // Bet Lab reads the Odds Module's canonical quote book as virtual-game pricing input only. It never reads Prediction Engine selections, probabilities, confidence, or recommendations.
    // OddsWorkerService is the sole pricing writer. BetLab must only consume
    // the latest persisted quote snapshot and must never recalculate prices.
    const storedPrices =
      preloadedPrices ??
      asStoredOddsPrices(
        await this.oddsService.getFixturePrices(fixture.eventId),
      );
    const quoteMap = new Map<string, ResolvedStoredPrice>();

    for (const price of storedPrices) {
      const definition = FOOTBALL_MARKET_BY_ID.get(String(price.marketId));
      if (!definition) continue;

      const resolved = this.resolveStoredPrice(price);
      if (!resolved) continue;

      const marketCode = definition.betLabMarketCode as BetLabMarketCode;
      quoteMap.set(
        this.quoteKey(marketCode, String(price.selectionKey)),
        resolved,
      );
    }

    const context = {
      homeTeamName: fixture.homeTeamName,
      awayTeamName: fixture.awayTeamName,
      players: extractRosterPlayers(asRecord(fixture.payload.summary) ?? {}),
    };

    const markets: BetLabMarketWithQuotes[] = BET_LAB_MARKET_CATALOG.map(
      (market) => {
        const selections = expandMarketSelections(market, context).map(
          (selection) => {
            const quote = quoteMap.get(
              this.quoteKey(market.code, selection.code),
            );
            // Odds owns the freshness decision; BetLab only consumes it.
            const isStale = Boolean(quote && !quote.isFresh);
            const available = Boolean(quote && !isStale);
            return {
              ...selection,
              available,
              // Old but otherwise valid snapshots remain visible for diagnosis.
              // They are explicitly unavailable for new simulated tickets.
              decimalOdds: quote?.decimalOdds ?? null,
              oddsSource: quote?.oddsSource ?? null,
              priceType: quote?.priceType ?? null,
              bookmaker: quote?.bookmaker ?? null,
              providerUpdatedAt: quote?.providerUpdatedAt ?? null,
              oddsTimestampBasis: quote?.oddsTimestampBasis ?? null,
              oddsCapturedAt: quote?.oddsCapturedAt ?? null,
              oddsFreshUntil: quote?.oddsFreshUntil ?? null,
              oddsBasis: quote?.oddsBasis ?? null,
              oddsCalculationMethod: quote?.oddsCalculationMethod ?? null,
              isStale,
              unavailableReason: available
                ? undefined
                : isStale
                  ? 'The Odds module has marked this stored price stale; it cannot be used for a new ticket.'
                  : 'No valid stored price is available for this selection.',
            } satisfies BetLabSelectionQuote;
          },
        );
        const availableSelectionCount = selections.filter(
          (selection) => selection.available,
        ).length;
        return {
          code: market.code,
          jsonVariable: market.jsonVariable,
          fullName: market.fullName,
          abbreviation: market.abbreviation,
          category: market.category,
          period: market.period,
          available: availableSelectionCount > 0,
          availableSelectionCount,
          selections,
          notes: market.notes,
        };
      },
    );

    let latestQuoteTimestamp: Date | null = null;
    let earliestQuoteExpiry: number | null = null;
    for (const quote of quoteMap.values()) {
      if (
        !latestQuoteTimestamp ||
        quote.oddsCapturedAt.getTime() > latestQuoteTimestamp.getTime()
      ) {
        latestQuoteTimestamp = quote.oddsCapturedAt;
      }
      if (!quote.isFresh) continue;
      const expiry =
        quote.oddsFreshUntil?.getTime() ?? Number.POSITIVE_INFINITY;
      earliestQuoteExpiry =
        earliestQuoteExpiry === null
          ? expiry
          : Math.min(earliestQuoteExpiry, expiry);
    }
    const freshnessBoundary =
      earliestQuoteExpiry === null
        ? null
        : Math.min(fixture.fixtureDate.getTime(), earliestQuoteExpiry);

    return {
      oddsCapturedAt: latestQuoteTimestamp,
      oddsFreshUntil:
        freshnessBoundary === null ? null : new Date(freshnessBoundary),
      markets,
    };
  }

  /**
   * Resolve only an exact, Odds-module-approved canonical quote. BetLab does
   * not synthesize prices, derive related markets or apply its own freshness
   * policy; missing or stale quotes remain unavailable for ticket placement.
   */
  private resolveStoredPrice(
    price: StoredOddsPrice,
  ): ResolvedStoredPrice | null {
    // A stored price is not automatically an approved virtual-game quote.
    // Odds must explicitly mark the exact selection as usable.
    if (price.predictionReady !== true) return null;

    const decimalOdds = Number(price.decimalOdds);
    if (
      !Number.isFinite(decimalOdds) ||
      decimalOdds < BET_LAB_CONFIG.odds.minimumDecimalOdds ||
      decimalOdds > BET_LAB_CONFIG.odds.maximumDecimalOdds
    ) {
      return null;
    }

    const rawPriceType =
      typeof price.priceType === 'string' ? price.priceType.toUpperCase() : '';
    if (rawPriceType !== 'PROVIDER' && rawPriceType !== 'ESTIMATED') {
      return null;
    }
    const priceType = rawPriceType;
    const provider =
      typeof price.provider === 'string'
        ? price.provider.trim().toUpperCase()
        : '';
    const providerUpdatedAt = this.toOptionalDate(price.providerUpdatedAt);
    const storedAt = this.toOptionalDate(price.updatedAt);
    const oddsCapturedAt =
      this.toOptionalDate(price.oddsCapturedAt) ??
      (priceType === 'PROVIDER' ? (providerUpdatedAt ?? storedAt) : storedAt);
    if (!oddsCapturedAt) return null;
    const oddsBasis =
      typeof price.oddsBasis === 'string' ? price.oddsBasis : '';
    const oddsCalculationMethod =
      typeof price.oddsCalculationMethod === 'string'
        ? price.oddsCalculationMethod.trim()
        : '';
    if (
      !oddsCalculationMethod ||
      ![
        'BOOKMAKER_ONLY',
        'BOOKMAKER_PLUS_HISTORY',
        'HISTORICAL_ONLY',
        'PRIOR_ONLY',
      ].includes(oddsBasis)
    )
      return null;

    let oddsSource: BetLabOddsSource;
    if (priceType === 'ESTIMATED') {
      oddsSource = BetLabOddsSource.ESTIMATED;
    } else {
      switch (provider) {
        case 'API_FOOTBALL':
          oddsSource = BetLabOddsSource.API_FOOTBALL;
          break;
        case 'THE_ODDS_API':
          oddsSource = BetLabOddsSource.THE_ODDS_API;
          break;
        case 'ESPN':
          oddsSource = BetLabOddsSource.ESPN_ODDS;
          break;
        default:
          oddsSource = BetLabOddsSource.UNKNOWN_PROVIDER;
          break;
      }
    }

    return {
      decimalOdds,
      oddsSource,
      priceType,
      bookmaker:
        typeof price.bookmaker === 'string' && price.bookmaker.trim()
          ? price.bookmaker.trim()
          : null,
      providerUpdatedAt,
      oddsTimestampBasis:
        priceType === 'ESTIMATED'
          ? 'MODEL_GENERATED'
          : providerUpdatedAt
            ? 'PROVIDER_UPDATED_AT'
            : 'INGESTED_AT',
      oddsCapturedAt,
      oddsFreshUntil: this.toOptionalDate(price.oddsFreshUntil),
      isFresh: price.isFresh === true,
      oddsBasis: oddsBasis as ResolvedStoredPrice['oddsBasis'],
      oddsCalculationMethod,
    };
  }

  private toOptionalDate(value: unknown): Date | null {
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value;
    }
    if (typeof value === 'string' || typeof value === 'number') {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    return null;
  }

  private assertPlaceableFixture(fixture: BetLabFixtureIdentity): void {
    const status = [
      fixture.status,
      fixture.statusDetail,
      fixture.statusShortDetail,
    ]
      .filter(Boolean)
      .join(' ')
      .toUpperCase();

    if (
      fixture.completed ||
      /(^|[^A-Z])(FINISHED|FULL[_ -]?TIME|FT|AET|PEN|FINAL|COMPLETED|AFTER EXTRA TIME|AFTER PENALTIES)([^A-Z]|$)/.test(
        status,
      )
    ) {
      throw new ConflictException('This match has already been completed.');
    }

    if (
      /POSTPON|\bPST\b|CANCEL|\bCANC\b|ABANDON|SUSPEND|INTERRUPT|DELAY|VOID|NO[_ -]?CONTEST/.test(
        status,
      )
    ) {
      throw new ConflictException(
        'This match is not available for Bet Lab tickets.',
      );
    }

    const live =
      fixture.live ||
      /LIVE|IN[_ ]?PROGRESS|IN[_ ]?PLAY|HALF[_ ]?TIME|FIRST[_ ]?HALF|SECOND[_ ]?HALF|EXTRA[_ ]?TIME/.test(
        status,
      );

    if (!live && fixture.fixtureDate.getTime() <= Date.now()) {
      throw new ConflictException(
        'Ticket placement is closed for this fixture.',
      );
    }
  }

  private parseDate(value: string, field: string): Date {
    const date = new Date(value);
    if (Number.isNaN(date.getTime()))
      throw new BadRequestException(`${field} must be a valid date`);
    return date;
  }

  private quoteKey(market: BetLabMarketCode, selectionCode: string): string {
    return `${market}:${selectionCode}`;
  }
}
