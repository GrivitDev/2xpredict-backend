import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BET_LAB_MARKET_BY_CODE, BET_LAB_MARKET_CATALOG, expandMarketSelections } from '../catalog/bet-lab-market-catalog';
import { BetLabMarketCode } from '../enums/bet-lab-market-code.enum';
import { BetLabOddsSource } from '../enums/bet-lab-odds-source.enum';
import type { BetLabOddsTimestampBasis, BetLabPriceType } from '../enums/bet-lab-odds-source.enum';
import { BET_LAB_CONFIG } from '../config/bet-lab.config';
import type {
  BetLabFixtureIdentity,
  BetLabMarketQuote,
  BetLabSelectionRequest,
  BetLabMarketWithQuotes,
  BetLabSelectionQuote,
} from '../interfaces/bet-lab-market.interface';
import { SportsDomainReadService } from '../../sports/services/sports-domain-read.service';
import type {
  SportsFixtureContextReadModel,
  SportsFixtureQuery,
} from '../../sports/interfaces/sports-read.interface';
import { OddsReadService } from '../../odds/services/odds-read.service';
import type { OddsQuoteSnapshot } from '../../odds/services/odds.service';
import {
  FOOTBALL_MARKET_BY_ID,
  FOOTBALL_MARKET_BY_BET_LAB_CODE,
} from '../../odds/catalog/football-market-catalog';
import {
  assertBetLabPreMatchFixture,
  isBetLabFixtureContextComplete,
  toBetLabFixtureIdentity,
} from '../utils/fixture.util';

interface ResolvedStoredPrice {
  decimalOdds: number;
  oddsSource: BetLabOddsSource;
  priceType: BetLabPriceType;
  bookmaker: string | null;
  providerUpdatedAt: Date | null;
  oddsTimestampBasis: BetLabOddsTimestampBasis;
  oddsCapturedAt: Date;
  oddsRecordUpdatedAt: Date | null;
  oddsFreshUntil: Date | null;
  isFresh: boolean;
  fairOdds: number | null;
  fairOddsBasis: 'MODEL' | 'PRIOR' | null;
  marketFairOdds: number | null;
  impliedProbability: number | null;
  fairProbability: number | null;
  valuePercent: number | null;
  dataQuality: number | null;
  sampleSize: number | null;
  calculationVersion: string | null;
  sourceRevision: number | null;
  fixtureSourceRevision: number | null;
  sourceDataUpdatedAt: Date | null;
  provider: 'ESPN' | 'THE_ODDS_API' | null;
  oddsBasis: 'BOOKMAKER_ONLY' | 'BOOKMAKER_PLUS_HISTORY' | 'HISTORICAL_ONLY' | 'PRIOR_ONLY' | null;
  oddsCalculationMethod: string | null;
}

interface FixturePricingSnapshot {
  oddsCapturedAt: Date | null;
  oddsFreshUntil: Date | null;
  markets: BetLabMarketWithQuotes[];
}

function asOddsPrices(value: unknown): OddsQuoteSnapshot[] {
  return Array.isArray(value) ? (value as OddsQuoteSnapshot[]) : [];
}

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function optionalDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function normalizeLine(value: unknown): number | undefined {
  const parsed = optionalNumber(value);
  return parsed === null ? undefined : Number(parsed.toFixed(3));
}

@Injectable()
export class BetLabMarketService {
  /** Coalesce repeated full-fixture reads made by concurrent accumulator operations. */
  private readonly pricingInFlight = new Map<string, Promise<FixturePricingSnapshot>>();

  constructor(
    private readonly sportsRead: SportsDomainReadService,
    private readonly oddsRead: OddsReadService,
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
    if (to.getTime() - from.getTime() > 90 * 24 * 60 * 60 * 1000) {
      throw new BadRequestException('Fixture query range cannot exceed 90 days');
    }

    const page = Math.max(1, Math.floor(Number(query.page) || 1));
    const limit = Math.min(100, Math.max(1, Math.floor(Number(query.limit) || 20)));
    let teamId = query.teamId?.trim() || undefined;
    if (teamId) {
      // Accept either normalized Sports IDs or their retained ESPN source IDs.
      const team = await this.sportsRead.getTeam(teamId);
      teamId = team?.id ?? teamId;
    }

    // Keep the count filter identical to the cursor-page filter. Sports uses
    // keyset pagination and intentionally does not calculate a total on every
    // read, so BetLab requests the count explicitly for this paginated endpoint.
    const fixtureFilter: Omit<SportsFixtureQuery, 'limit' | 'cursor' | 'sortOrder' | 'retainedOnly'> = {
      from,
      to,
      state: 'SCHEDULED',
      competitionId: query.leagueId?.trim() || undefined,
      teamId,
    };
    const totalPromise = this.sportsRead.countFixtures(fixtureFilter);

    let cursor: string | undefined;
    let pageResult: Awaited<ReturnType<SportsDomainReadService['getFixtures']>> | null = null;
    for (let currentPage = 1; currentPage <= page; currentPage += 1) {
      pageResult = await this.sportsRead.getFixtures({
        ...fixtureFilter,
        limit,
        cursor,
      });
      if (currentPage < page) {
        if (!pageResult.nextCursor) {
          pageResult = { ...pageResult, items: [] };
          break;
        }
        cursor = pageResult.nextCursor;
      }
    }

    const fixtures = pageResult?.items ?? [];
    const contexts = await this.sportsRead.getFixtureContexts(fixtures.map((fixture) => fixture.id));
    const contextById = new Map(contexts.map((context) => [context.fixture.id, context]));
    const identities = fixtures
      .map((fixture) => contextById.get(fixture.id))
      .filter((context): context is SportsFixtureContextReadModel =>
        context !== undefined && isBetLabFixtureContextComplete(context),
      )
      .map(toBetLabFixtureIdentity);

    const prices = asOddsPrices(
      await this.oddsRead.getPricesForFixtures(identities.map((fixture) => fixture.eventId)),
    );
    const priceCountByEvent = new Map<string, number>();
    for (const price of prices) {
      const resolved = this.resolveStoredPrice(price);
      if (!resolved?.isFresh) continue;
      priceCountByEvent.set(
        price.eventId,
        (priceCountByEvent.get(price.eventId) ?? 0) + 1,
      );
    }

    const identityById = new Map(identities.map((identity) => [identity.eventId, identity]));
    const items = fixtures.flatMap((fixture) => {
      const identity = identityById.get(fixture.id);
      if (!identity) return [];
      const pricedSelectionCount = priceCountByEvent.get(identity.eventId) ?? 0;
      return [{
        eventId: identity.eventId,
        leagueId: identity.leagueId,
        leagueName: identity.leagueName,
        fixtureDate: identity.fixtureDate,
        status: identity.status,
        live: identity.live,
        completed: identity.completed,
        homeTeam: { id: identity.homeTeamId, name: identity.homeTeamName },
        awayTeam: { id: identity.awayTeamId, name: identity.awayTeamName },
        venueName: identity.venueName,
        hasSportsData: true,
        hasPricedSelections: pricedSelectionCount > 0,
        pricedSelectionCount,
        sportsUpdatedAt: identity.sportsUpdatedAt,
      }];
    });

    const total = await totalPromise;
    return {
      items,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async getFixtureIdentity(eventId: string, requireUpcoming = true): Promise<BetLabFixtureIdentity> {
    const normalizedId = String(eventId ?? '').trim();
    if (!normalizedId) throw new BadRequestException('eventId is required');

    const contexts = await this.sportsRead.getFixtureContexts([normalizedId]);
    const context = contexts[0];
    if (!context) throw new NotFoundException(`Fixture ${normalizedId} was not found`);
    if (!isBetLabFixtureContextComplete(context)) {
      throw new ConflictException('The Sports module does not yet have a complete competition and team context for this fixture.');
    }

    const identity = toBetLabFixtureIdentity(context);
    if (requireUpcoming) this.assertPlaceableFixture(identity);
    return identity;
  }

  getMarketCatalog() {
    return BET_LAB_MARKET_CATALOG.map((market) => ({
      code: market.code,
      jsonVariable: market.jsonVariable,
      fullName: market.fullName,
      abbreviation: market.abbreviation,
      category: market.category,
      period: market.period,
      selectionMode: market.selectionMode,
      selections: expandMarketSelections(market, {
        homeTeamName: 'Home Team',
        awayTeamName: 'Away Team',
      }),
      lines: market.lines ?? [],
      notes: market.notes,
      pricingEnabled: market.pricingEnabled !== false,
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
    const quotes = await this.getSelectionQuotes([{ eventId, marketCode, selectionCode }]);
    const quote = quotes[0];
    if (!quote) throw new NotFoundException('The requested Bet Lab selection could not be resolved.');
    return quote;
  }

  /**
   * Resolve exact requested prices in one Odds-module query. No local pricing,
   * probability conversion, line substitution or derived quote is permitted.
   */
  async getSelectionQuotes(requests: BetLabSelectionRequest[]): Promise<BetLabMarketQuote[]> {
    if (!requests.length) return [];

    const normalizedRequests = requests.map((request) => ({
      ...request,
      eventId: String(request.eventId ?? '').trim(),
      selectionCode: String(request.selectionCode ?? '').trim(),
    }));
    if (normalizedRequests.some((request) => !request.eventId || !request.selectionCode)) {
      throw new BadRequestException('Every selection must include a fixture and selection code.');
    }

    const requestedEventIds = [...new Set(normalizedRequests.map((request) => request.eventId))];
    const contexts = await this.sportsRead.getFixtureContexts(requestedEventIds);
    const contextByRequestedId = new Map<string, SportsFixtureContextReadModel>();
    for (const context of contexts) {
      contextByRequestedId.set(context.fixture.id, context);
      contextByRequestedId.set(context.fixture.espnEventId, context);
    }

    const requested = normalizedRequests.map((request) => {
      const context = contextByRequestedId.get(request.eventId);
      if (!context) throw new NotFoundException(`Fixture ${request.eventId} was not found`);
      if (!isBetLabFixtureContextComplete(context)) {
        throw new ConflictException(`The Sports context for fixture ${request.eventId} is incomplete.`);
      }
      const fixture = toBetLabFixtureIdentity(context);
      this.assertPlaceableFixture(fixture);

      const market = BET_LAB_MARKET_BY_CODE.get(request.marketCode);
      const canonicalMarket = FOOTBALL_MARKET_BY_BET_LAB_CODE.get(String(request.marketCode));
      if (!market || !canonicalMarket) {
        throw new BadRequestException(`Unsupported market code: ${request.marketCode}`);
      }
      if (market.pricingEnabled === false || canonicalMarket.pricingEnabled === false) {
        throw new ConflictException(`${market.fullName} is not currently priced by the Odds module.`);
      }

      const selection = expandMarketSelections(market, {
        homeTeamName: fixture.homeTeamName,
        awayTeamName: fixture.awayTeamName,
      }).find((item) => item.code === request.selectionCode);
      if (!selection) throw new BadRequestException('Unknown market or selection for this fixture');

      return {
        ...request,
        eventId: fixture.eventId,
        fixture,
        market,
        canonicalMarket,
        selection,
      };
    });

    const storedPrices = asOddsPrices(
      await this.oddsRead.getPricesForSelections(
        requested.map((item) => ({
          eventId: item.eventId,
          marketId: item.canonicalMarket.id,
          selectionKey: item.selection.code,
          ...(item.selection.line !== undefined ? { line: item.selection.line } : {}),
        })),
      ),
    );

    const priceByKey = new Map<string, OddsQuoteSnapshot>();
    for (const price of storedPrices) {
      priceByKey.set(
        this.exactPriceKey(price.eventId, price.marketId, price.selectionKey, price.line),
        price,
      );
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
            ? 'The Odds module has marked this exact price stale or unusable; the selection cannot be placed.'
            : 'No Odds-module-approved price exists for this exact market, selection and line.',
        );
      }
      return this.toSelectionQuote(item.fixture, item.market, item.selection, resolved);
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
      selection: { ...selection },
      decimalOdds: price.decimalOdds,
      oddsSource: price.oddsSource,
      priceType: price.priceType,
      bookmaker: price.bookmaker,
      providerUpdatedAt: price.providerUpdatedAt,
      oddsTimestampBasis: price.oddsTimestampBasis,
      oddsCapturedAt: price.oddsCapturedAt,
      oddsRecordUpdatedAt: price.oddsRecordUpdatedAt,
      oddsFreshUntil: price.oddsFreshUntil,
      fairOdds: price.fairOdds,
      fairOddsBasis: price.fairOddsBasis,
      marketFairOdds: price.marketFairOdds,
      impliedProbability: price.impliedProbability,
      fairProbability: price.fairProbability,
      valuePercent: price.valuePercent,
      dataQuality: price.dataQuality,
      sampleSize: price.sampleSize,
      calculationVersion: price.calculationVersion,
      sourceRevision: price.sourceRevision,
      fixtureSourceRevision: price.fixtureSourceRevision,
      sourceDataUpdatedAt: price.sourceDataUpdatedAt,
      provider: price.provider,
      isFresh: price.isFresh,
      oddsBasis: price.oddsBasis,
      oddsCalculationMethod: price.oddsCalculationMethod,
    };
  }

  private buildMarketPricing(fixture: BetLabFixtureIdentity): Promise<FixturePricingSnapshot> {
    const eventId = fixture.eventId;
    const existing = this.pricingInFlight.get(eventId);
    if (existing) return existing;

    const pending = this.buildMarketPricingFromStore(fixture);
    this.pricingInFlight.set(eventId, pending);
    void pending.finally(() => {
      if (this.pricingInFlight.get(eventId) === pending) this.pricingInFlight.delete(eventId);
    }).catch(() => undefined);
    return pending;
  }

  private async buildMarketPricingFromStore(
    fixture: BetLabFixtureIdentity,
  ): Promise<FixturePricingSnapshot> {
    // The Odds worker is the sole source of single-selection prices. Bet Lab
    // reads its persisted snapshots and never calls a provider or reprices a market.
    const storedPrices = asOddsPrices(await this.oddsRead.getFixturePrices(fixture.eventId));
    const quoteMap = new Map<string, ResolvedStoredPrice>();

    for (const price of storedPrices) {
      const definition = FOOTBALL_MARKET_BY_ID.get(String(price.marketId));
      if (!definition || definition.pricingEnabled === false) continue;
      const resolved = this.resolveStoredPrice(price);
      if (!resolved) continue;
      const marketCode = definition.betLabMarketCode as BetLabMarketCode;
      quoteMap.set(this.quoteKey(marketCode, String(price.selectionKey), price.line), resolved);
    }

    const markets: BetLabMarketWithQuotes[] = BET_LAB_MARKET_CATALOG.map((market) => {
      const pricingEnabled = market.pricingEnabled !== false;
      const selections = expandMarketSelections(market, {
        homeTeamName: fixture.homeTeamName,
        awayTeamName: fixture.awayTeamName,
      }).map((selection) => {
        const quote = pricingEnabled
          ? quoteMap.get(this.quoteKey(market.code, selection.code, selection.line))
          : undefined;
        const isStale = Boolean(quote && !quote.isFresh);
        const available = Boolean(pricingEnabled && quote && quote.isFresh);
        const unavailableReason = !pricingEnabled
          ? 'This market is disabled in the canonical Odds catalogue until its required Sports data is supported.'
          : available
            ? undefined
            : isStale
              ? 'The Odds module has marked this stored price stale; it cannot be used for a new ticket.'
              : 'No Odds-module-approved price is available for this exact selection.';

        return {
          ...selection,
          available,
          decimalOdds: quote?.decimalOdds ?? null,
          oddsSource: quote?.oddsSource ?? null,
          priceType: quote?.priceType ?? null,
          bookmaker: quote?.bookmaker ?? null,
          providerUpdatedAt: quote?.providerUpdatedAt ?? null,
          oddsTimestampBasis: quote?.oddsTimestampBasis ?? null,
          oddsCapturedAt: quote?.oddsCapturedAt ?? null,
          oddsRecordUpdatedAt: quote?.oddsRecordUpdatedAt ?? null,
          oddsFreshUntil: quote?.oddsFreshUntil ?? null,
          fairOdds: quote?.fairOdds ?? null,
          fairOddsBasis: quote?.fairOddsBasis ?? null,
          marketFairOdds: quote?.marketFairOdds ?? null,
          impliedProbability: quote?.impliedProbability ?? null,
          fairProbability: quote?.fairProbability ?? null,
          valuePercent: quote?.valuePercent ?? null,
          dataQuality: quote?.dataQuality ?? null,
          sampleSize: quote?.sampleSize ?? null,
          calculationVersion: quote?.calculationVersion ?? null,
          sourceRevision: quote?.sourceRevision ?? null,
          fixtureSourceRevision: quote?.fixtureSourceRevision ?? null,
          sourceDataUpdatedAt: quote?.sourceDataUpdatedAt ?? null,
          provider: quote?.provider ?? null,
          isFresh: quote?.isFresh ?? false,
          oddsBasis: quote?.oddsBasis ?? null,
          oddsCalculationMethod: quote?.oddsCalculationMethod ?? null,
          isStale,
          unavailableReason,
        } satisfies BetLabSelectionQuote;
      });

      return {
        code: market.code,
        jsonVariable: market.jsonVariable,
        fullName: market.fullName,
        abbreviation: market.abbreviation,
        category: market.category,
        period: market.period,
        available: selections.some((selection) => selection.available),
        availableSelectionCount: selections.filter((selection) => selection.available).length,
        pricingEnabled,
        selections,
        notes: market.notes,
      };
    });

    let latestQuoteTimestamp: Date | null = null;
    let earliestQuoteExpiry: number | null = null;
    for (const quote of quoteMap.values()) {
      if (!latestQuoteTimestamp || quote.oddsCapturedAt.getTime() > latestQuoteTimestamp.getTime()) {
        latestQuoteTimestamp = quote.oddsCapturedAt;
      }
      if (!quote.isFresh) continue;
      const expiry = quote.oddsFreshUntil?.getTime() ?? Number.POSITIVE_INFINITY;
      earliestQuoteExpiry = earliestQuoteExpiry === null ? expiry : Math.min(earliestQuoteExpiry, expiry);
    }
    const freshnessBoundary = earliestQuoteExpiry === null
      ? null
      : Math.min(fixture.fixtureDate.getTime(), earliestQuoteExpiry);

    return {
      oddsCapturedAt: latestQuoteTimestamp,
      oddsFreshUntil: freshnessBoundary === null ? null : new Date(freshnessBoundary),
      markets,
    };
  }

  /**
   * Accepts only exact Odds-module-approved rows. Freshness, provider priority,
   * price normalization and fair-price calculations are owned by Odds.
   */
  private resolveStoredPrice(price: OddsQuoteSnapshot): ResolvedStoredPrice | null {
    if (price.predictionReady !== true) return null;

    const decimalOdds = Number(price.decimalOdds);
    if (
      !Number.isFinite(decimalOdds) ||
      decimalOdds < BET_LAB_CONFIG.odds.minimumDecimalOdds ||
      decimalOdds > BET_LAB_CONFIG.odds.maximumDecimalOdds
    ) return null;

    const rawPriceType = String(price.priceType ?? '').toUpperCase();
    if (rawPriceType !== 'PROVIDER' && rawPriceType !== 'ESTIMATED') return null;
    const priceType = rawPriceType as BetLabPriceType;
    const provider = String(price.provider ?? '').trim().toUpperCase();
    const providerUpdatedAt = optionalDate(price.providerUpdatedAt);
    const storedAt = optionalDate(price.updatedAt);
    const capturedAt = optionalDate(price.oddsCapturedAt)
      ?? optionalDate(price.sourceDataUpdatedAt)
      ?? providerUpdatedAt
      ?? storedAt;
    if (!capturedAt) return null;

    const rawBasis = String(price.oddsBasis ?? '').toUpperCase();
    const oddsBasis = ['BOOKMAKER_ONLY', 'BOOKMAKER_PLUS_HISTORY', 'HISTORICAL_ONLY', 'PRIOR_ONLY'].includes(rawBasis)
      ? rawBasis as ResolvedStoredPrice['oddsBasis']
      : null;
    const method = typeof price.oddsCalculationMethod === 'string' && price.oddsCalculationMethod.trim()
      ? price.oddsCalculationMethod.trim()
      : null;

    let oddsSource: BetLabOddsSource;
    if (priceType === 'ESTIMATED') {
      oddsSource = BetLabOddsSource.ESTIMATED;
    } else {
      switch (provider) {
        case 'ESPN':
          oddsSource = BetLabOddsSource.ESPN_ODDS;
          break;
        case 'THE_ODDS_API':
        case 'ODDS_API':
          oddsSource = BetLabOddsSource.THE_ODDS_API;
          break;
        case 'API_FOOTBALL':
          oddsSource = BetLabOddsSource.API_FOOTBALL;
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
      bookmaker: typeof price.bookmaker === 'string' && price.bookmaker.trim() ? price.bookmaker.trim() : null,
      providerUpdatedAt,
      oddsTimestampBasis: priceType === 'ESTIMATED'
        ? 'MODEL_GENERATED'
        : providerUpdatedAt
          ? 'PROVIDER_UPDATED_AT'
          : 'INGESTED_AT',
      oddsCapturedAt: capturedAt,
      oddsRecordUpdatedAt: storedAt,
      oddsFreshUntil: optionalDate(price.oddsFreshUntil),
      isFresh: price.isFresh === true,
      fairOdds: optionalNumber(price.fairOdds),
      fairOddsBasis: price.fairOddsBasis === 'MODEL' || price.fairOddsBasis === 'PRIOR'
        ? price.fairOddsBasis
        : null,
      marketFairOdds: optionalNumber(price.marketFairOdds),
      impliedProbability: optionalNumber(price.impliedProbability),
      fairProbability: optionalNumber(price.fairProbability),
      valuePercent: optionalNumber(price.valuePercent),
      dataQuality: optionalNumber(price.dataQuality),
      sampleSize: optionalNumber(price.sampleSize),
      calculationVersion: typeof price.calculationVersion === 'string' && price.calculationVersion.trim()
        ? price.calculationVersion.trim()
        : null,
      sourceRevision: optionalNumber(price.sourceRevision),
      fixtureSourceRevision: optionalNumber(price.fixtureSourceRevision),
      sourceDataUpdatedAt: optionalDate(price.sourceDataUpdatedAt),
      provider: provider === 'ESPN' || provider === 'THE_ODDS_API' || provider === 'ODDS_API'
        ? (provider === 'ODDS_API' ? 'THE_ODDS_API' : provider)
        : null,
      oddsBasis,
      oddsCalculationMethod: method,
    };
  }

  private assertPlaceableFixture(fixture: BetLabFixtureIdentity): void {
    assertBetLabPreMatchFixture(fixture);
  }

  private exactPriceKey(eventId: string, marketId: string, selectionKey: string, line?: unknown): string {
    const normalizedLine = normalizeLine(line);
    return `${eventId}:${marketId}:${selectionKey}:${normalizedLine === undefined ? '-' : normalizedLine}`;
  }

  private quoteKey(market: BetLabMarketCode, selectionCode: string, line?: number): string {
    const normalizedLine = normalizeLine(line);
    return `${market}:${selectionCode}:${normalizedLine === undefined ? '-' : normalizedLine}`;
  }

  private parseDate(value: string, field: string): Date {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new BadRequestException(`${field} must be a valid date`);
    return date;
  }
}

