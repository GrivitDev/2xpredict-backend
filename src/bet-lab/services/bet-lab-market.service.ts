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
  BetLabMarketWithQuotes,
  BetLabSelectionQuote,
} from '../interfaces/bet-lab-market.interface';
import { EspnFixture } from '../../sports/schemas/espn/espn-fixture.schema';
import { EspnLeague } from '../../sports/schemas/espn/espn-league.schema';
import { OddsService } from '../../odds/services/odds.service';
import { FOOTBALL_MARKET_BY_ID } from '../../odds/catalog/football-market-catalog';
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
  selectionKey: unknown;
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
  oddsBasis: 'BOOKMAKER_ONLY' | 'BOOKMAKER_PLUS_HISTORY' | 'HISTORICAL_ONLY' | 'PRIOR_ONLY' | null;
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
    private readonly oddsService: OddsService,
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
      status: {
        $not: /POSTPONED|CANCELLED|CANCELED|ABANDONED|SUSPENDED|INTERRUPTED/i,
      },
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
    const maximumAgeMs =
      BET_LAB_CONFIG.odds.maximumAgeHours * 60 * 60 * 1000;
    for (const price of storedPrices) {
      const resolved = this.resolveStoredPrice(price);
      if (!resolved) continue;
      const ageMs = now.getTime() - resolved.oddsCapturedAt.getTime();
      if (ageMs < 0 || ageMs > maximumAgeMs) continue;
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
      selectionTemplate:
        market.selectionMode.startsWith('PLAYER_') ||
        market.selectionMode === 'PLAYER_ANYTIME'
          ? this.getPlayerSelectionTemplate(market.selectionMode)
          : undefined,
      notes: market.notes,
      dynamicSelections: market.selectionMode !== 'STATIC',
    }));
  }

  private getPlayerSelectionTemplate(mode: string) {
    const templates: Record<
      string,
      {
        fullNamePattern: string;
        abbreviationPattern: string;
        jsonVariablePattern: string;
      }
    > = {
      PLAYER_ANYTIME: {
        fullNamePattern: '{PLAYER_NAME} to Score Anytime',
        abbreviationPattern: '{PLAYER_ABBREVIATION} ATS',
        jsonVariablePattern: 'player{PLAYER_ID}AnytimeGoal',
      },
      PLAYER_FIRST_SCORER: {
        fullNamePattern: '{PLAYER_NAME} to Score First',
        abbreviationPattern: '{PLAYER_ABBREVIATION} FGS',
        jsonVariablePattern: 'player{PLAYER_ID}FirstGoalscorer',
      },
      PLAYER_BOOKING: {
        fullNamePattern: '{PLAYER_NAME} to Be Booked',
        abbreviationPattern: '{PLAYER_ABBREVIATION} BOOKED',
        jsonVariablePattern: 'player{PLAYER_ID}ToBeBooked',
      },
      PLAYER_SENDING_OFF: {
        fullNamePattern: '{PLAYER_NAME} to Be Sent Off',
        abbreviationPattern: '{PLAYER_ABBREVIATION} RED',
        jsonVariablePattern: 'player{PLAYER_ID}ToBeSentOff',
      },
      PLAYER_ASSIST: {
        fullNamePattern: '{PLAYER_NAME} to Record an Assist',
        abbreviationPattern: '{PLAYER_ABBREVIATION} AST',
        jsonVariablePattern: 'player{PLAYER_ID}ToRecordAssist',
      },
      PLAYER_SHOTS: {
        fullNamePattern: '{PLAYER_NAME} Over/Under {LINE} Shots',
        abbreviationPattern: '{PLAYER_ABBREVIATION} O/U {LINE}',
        jsonVariablePattern: 'player{PLAYER_ID}Shots{OVER_UNDER}{LINE}',
      },
      PLAYER_SHOTS_ON_TARGET: {
        fullNamePattern: '{PLAYER_NAME} Over/Under {LINE} Shots on Target',
        abbreviationPattern: '{PLAYER_ABBREVIATION} SOT O/U {LINE}',
        jsonVariablePattern: 'player{PLAYER_ID}ShotsOnTarget{OVER_UNDER}{LINE}',
      },
    };
    return templates[mode];
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
    const definition = BET_LAB_MARKET_BY_CODE.get(marketCode);
    if (!definition)
      throw new BadRequestException(`Unsupported market code: ${marketCode}`);

    // Resolve identity and its price list once; accumulator placement calls this in parallel.
    const fixture = await this.getFixtureIdentity(eventId, true);
    const pricing = await this.buildMarketPricing(fixture);
    const market = pricing.markets.find((item) => item.code === marketCode);
    const selection = market?.selections.find(
      (item) => item.code === selectionCode,
    );
    if (!market || !selection)
      throw new BadRequestException(
        'Unknown market or selection for this fixture',
      );
    if (
      !selection.available ||
      selection.decimalOdds === null ||
      !selection.oddsSource ||
      !selection.oddsCapturedAt
    ) {
      throw new ConflictException(
        selection.unavailableReason ??
          'This selection is not currently priced and cannot be placed.',
      );
    }

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
      decimalOdds: selection.decimalOdds,
      oddsSource: selection.oddsSource,
      priceType: selection.priceType!,
      bookmaker: selection.bookmaker,
      providerUpdatedAt: selection.providerUpdatedAt,
      oddsTimestampBasis: selection.oddsTimestampBasis!,
      oddsCapturedAt: selection.oddsCapturedAt,
      oddsBasis: selection.oddsBasis,
      oddsCalculationMethod: selection.oddsCalculationMethod,
    };
  }

  private buildMarketPricing(
    fixture: BetLabFixtureIdentity,
  ): Promise<FixturePricingSnapshot> {
    const eventId = String(fixture.eventId);
    const existing = this.pricingInFlight.get(eventId);
    if (existing) return existing;

    const pending = this.buildMarketPricingFromStore(fixture);
    this.pricingInFlight.set(eventId, pending);
    void pending.finally(() => {
      if (this.pricingInFlight.get(eventId) === pending) {
        this.pricingInFlight.delete(eventId);
      }
    }).catch(() => undefined);
    return pending;
  }

  private async buildMarketPricingFromStore(
    fixture: BetLabFixtureIdentity,
  ): Promise<FixturePricingSnapshot> {
    // Bet Lab reads the Odds Module's canonical quote book as virtual-game pricing input only. It never reads Prediction Engine selections, probabilities, confidence, or recommendations.
    await this.oddsService.refreshFixture(fixture.eventId);
    const storedPrices = asStoredOddsPrices(
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
            const ageMs = quote
              ? Date.now() - quote.oddsCapturedAt.getTime()
              : Number.POSITIVE_INFINITY;
            const maximumAgeMs =
              BET_LAB_CONFIG.odds.maximumAgeHours * 60 * 60 * 1000;
            const isStale = Boolean(
              quote && (ageMs < 0 || ageMs > maximumAgeMs),
            );
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
              oddsBasis: quote?.oddsBasis ?? null,
              oddsCalculationMethod: quote?.oddsCalculationMethod ?? null,
              isStale,
              unavailableReason: available
                ? undefined
                : isStale
                  ? `This price is stale; prices older than ${BET_LAB_CONFIG.odds.maximumAgeHours} hours cannot be used.`
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

    const quoteTimestamps = [...quoteMap.values()].map((quote) =>
      quote.oddsCapturedAt.getTime(),
    );
    const latestQuoteTimestamp = quoteTimestamps.length
      ? new Date(Math.max(...quoteTimestamps))
      : null;

    const availableQuoteTimestamps = markets.flatMap((market) =>
      market.selections
        .filter((selection) => selection.available && selection.oddsCapturedAt)
        .map((selection) => selection.oddsCapturedAt!.getTime()),
    );
    const earliestQuoteExpiry = availableQuoteTimestamps.length
      ? Math.min(...availableQuoteTimestamps) +
        BET_LAB_CONFIG.odds.maximumAgeHours * 60 * 60 * 1000
      : null;
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
   * Resolve the Odds module's canonical quote into the Bet Lab virtual-price
   * contract. Actual provider timestamps win; legacy rows fall back to the
   * canonical record timestamp and disclose that timestamp basis.
   */
  private resolveStoredPrice(
    price: StoredOddsPrice,
  ): ResolvedStoredPrice | null {
    const decimalOdds = Number(price.decimalOdds);
    if (
      !Number.isFinite(decimalOdds) ||
      decimalOdds < BET_LAB_CONFIG.odds.minimumDecimalOdds ||
      decimalOdds > BET_LAB_CONFIG.odds.maximumDecimalOdds
    ) {
      return null;
    }

    const rawPriceType = String(price.priceType ?? '').toUpperCase();
    if (rawPriceType !== 'PROVIDER' && rawPriceType !== 'ESTIMATED') {
      return null;
    }
    const priceType = rawPriceType as BetLabPriceType;
    const provider = String(price.provider ?? '').trim().toUpperCase();
    const providerUpdatedAt = this.toOptionalDate(price.providerUpdatedAt);
    const storedAt = this.toOptionalDate(price.updatedAt);
    const oddsCapturedAt =
      priceType === 'PROVIDER'
        ? providerUpdatedAt ?? storedAt
        : storedAt;
    if (!oddsCapturedAt) return null;

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
      bookmaker: price.bookmaker == null || String(price.bookmaker).trim() === ''
        ? null
        : String(price.bookmaker).trim(),
      providerUpdatedAt,
      oddsTimestampBasis:
        priceType === 'ESTIMATED'
          ? 'MODEL_GENERATED'
          : providerUpdatedAt
            ? 'PROVIDER_UPDATED_AT'
            : 'INGESTED_AT',
      oddsCapturedAt,
      oddsBasis: ['BOOKMAKER_ONLY', 'BOOKMAKER_PLUS_HISTORY', 'HISTORICAL_ONLY', 'PRIOR_ONLY'].includes(String(price.oddsBasis))
        ? String(price.oddsBasis) as ResolvedStoredPrice['oddsBasis']
        : null,
      oddsCalculationMethod: String(price.oddsCalculationMethod ?? '').trim() || null,
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
    const status = String(fixture.status ?? '').toUpperCase();

    if (
      fixture.completed ||
      /FINISHED|FULL[_ ]?TIME|\bFT\b|\bFINAL\b|COMPLETED/.test(status)
    ) {
      throw new ConflictException('This match has already been completed.');
    }

    if (
      /POSTPON|\bPST\b|CANCELLED|CANCELED|ABANDONED|SUSPENDED|INTERRUPTED/.test(status)
    ) {
      throw new ConflictException('This match is not available for Bet Lab tickets.');
    }

    const live = fixture.live ||
      /LIVE|IN[_ ]?PROGRESS|IN[_ ]?PLAY|HALF[_ ]?TIME|FIRST[_ ]?HALF|SECOND[_ ]?HALF|EXTRA[_ ]?TIME/.test(status);

    if (!live && fixture.fixtureDate.getTime() <= Date.now()) {
      throw new ConflictException('Ticket placement is closed for this fixture.');
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
