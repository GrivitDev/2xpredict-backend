import {
  BadRequestException,
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { EspnFixture } from '../../sports/schemas/espn/espn-fixture.schema';
import { EspnLeague } from '../../sports/schemas/espn/espn-league.schema';
import { FOOTBALL_MARKET_CATALOG } from '../catalog/football-market-catalog';
import { OddsService } from '../services/odds.service';
import { OddsMonitorService } from '../services/odds-monitor.service';

const MAX_RANGE_DAYS = 8;
const MAX_FIXTURES = 500;

type StoredPrice = {
  eventId: string;
  marketId: string;
  selectionKey: string;
  line?: number;
  decimalOdds: number;
  priceType: 'PROVIDER' | 'ESTIMATED';
  provider?: 'API_FOOTBALL' | 'THE_ODDS_API' | 'ESPN';
  bookmaker?: string;
  fairOdds?: number | null;
  fairOddsBasis?: 'MODEL' | 'PRIOR';
  marketFairOdds?: number | null;
  impliedProbability?: number | null;
  valuePercent?: number | null;
  providerUpdatedAt?: Date | string;
  updatedAt?: Date | string;
};

@Controller('odds/admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class OddsCenterController {
  constructor(
    @InjectModel(EspnFixture.name)
    private readonly fixtureModel: Model<EspnFixture>,
    @InjectModel(EspnLeague.name)
    private readonly leagueModel: Model<EspnLeague>,
    private readonly oddsService: OddsService,
    private readonly oddsMonitorService: OddsMonitorService,
  ) {}

  /** Read-only diagnostics endpoint. It does not trigger collection or mutate prices. */
  @Get('monitor')
  async getOddsMonitor() {
    return this.oddsMonitorService.getOverview();
  }

  /** Read-only endpoint. It never refreshes prices or queues collection work. */
  @Get('center')
  async getOddsCenter(
    @Query('from') fromValue?: string,
    @Query('to') toValue?: string,
  ) {
    const from = this.parseDate(fromValue, 'from');
    const to = this.parseDate(toValue, 'to');
    if (to <= from) throw new BadRequestException('to must be later than from');
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86_400_000) {
      throw new BadRequestException(
        `Date range cannot exceed ${MAX_RANGE_DAYS} days`,
      );
    }

    const fixtures = await this.fixtureModel
      .find({
        fixtureDate: { $gte: from, $lt: to },
        live: { $ne: true },
        completed: { $ne: true },
      })
      .sort({ fixtureDate: 1 })
      .limit(MAX_FIXTURES)
      .select({
        eventId: 1,
        leagueId: 1,
        fixtureDate: 1,
        live: 1,
        completed: 1,
        homeTeamId: 1,
        awayTeamId: 1,
        'payload.name': 1,
        'payload.competitions.name': 1,
        'payload.competitions.shortName': 1,
        'payload.competitions.competitors.homeAway': 1,
        'payload.competitions.competitors.team.displayName': 1,
        'payload.competitions.competitors.team.name': 1,
        'payload.competitions.competitors.team.shortDisplayName': 1,
      })
      .lean()
      .exec();

    const eventIds = fixtures.map((fixture: any) => String(fixture.eventId));
    const [prices, leagues] = await Promise.all([
      this.oddsService.getPricesForFixtures(eventIds) as Promise<StoredPrice[]>,
      this.leagueModel
        .find({
          leagueId: {
            $in: [
              ...new Set(
                fixtures.map((fixture: any) =>
                  String(fixture.leagueId).toLowerCase(),
                ),
              ),
            ],
          },
        })
        .select({
          leagueId: 1,
          name: 1,
          country: 1,
          priority: 1,
          isPriority: 1,
          payload: 1,
        })
        .lean()
        .exec(),
    ]);

    const leagueById = new Map(
      leagues.map((league: any) => [
        String(league.leagueId).toLowerCase(),
        league,
      ]),
    );
    const pricesByEvent = new Map<string, StoredPrice[]>();
    for (const price of prices) {
      const odds = Number(price.decimalOdds);
      if (!Number.isFinite(odds) || odds < 1.01) continue;
      const key = String(price.eventId);
      const list = pricesByEvent.get(key) ?? [];
      list.push(price);
      pricesByEvent.set(key, list);
    }

    const marketById = new Map(
      FOOTBALL_MARKET_CATALOG.map((market) => [market.id, market]),
    );
    const items = fixtures.flatMap((fixture: any) => {
      const eventId = String(fixture.eventId);
      const fixturePrices = pricesByEvent.get(eventId) ?? [];
      if (!fixturePrices.length) return [];

      const payload = fixture.payload ?? {};
      const competition = Array.isArray(payload.competitions)
        ? (payload.competitions[0] ?? {})
        : {};
      const competitors = Array.isArray(competition.competitors)
        ? competition.competitors
        : [];
      const homeCompetitor =
        competitors.find((item: any) => item.homeAway === 'home') ??
        competitors[0];
      const awayCompetitor =
        competitors.find((item: any) => item.homeAway === 'away') ??
        competitors[1];
      const teamName = (competitor: any, fallback: string) =>
        competitor?.team?.displayName ??
        competitor?.team?.name ??
        competitor?.team?.shortDisplayName ??
        fallback;
      const league = leagueById.get(String(fixture.leagueId).toLowerCase());
      const grouped = new Map<string, any>();

      for (const price of fixturePrices) {
        const definition = marketById.get(String(price.marketId));
        if (!definition) continue;
        const market = grouped.get(definition.id) ?? {
          id: definition.id,
          name: definition.fullName,
          abbreviation: definition.abbreviation,
          selections: [],
        };
        const staticSelection = definition.selections.find(
          (selection) => selection.key === price.selectionKey,
        );
        const line = typeof price.line === 'number' ? price.line : undefined;
        const selectionName =
          staticSelection?.fullName ??
          this.selectionLabel(price.selectionKey, line);
        market.selections.push({
          key: price.selectionKey,
          name: selectionName,
          line,
          odds: Number(price.decimalOdds),
          source: price.priceType,
          provider: price.provider ?? null,
          bookmaker: price.bookmaker ?? null,
          fairOdds: price.fairOdds ?? null,
          fairOddsBasis: price.fairOddsBasis ?? null,
          marketFairOdds: price.marketFairOdds ?? null,
          impliedProbability: price.impliedProbability ?? null,
          valuePercent: price.valuePercent ?? null,
          providerUpdatedAt: price.providerUpdatedAt ?? null,
          updatedAt: price.updatedAt ?? null,
        });
        grouped.set(definition.id, market);
      }

      const markets = [...grouped.values()].map((market) => ({
        ...market,
        selections: market.selections.sort((a: any, b: any) => {
          if (a.line !== undefined && b.line !== undefined && a.line !== b.line)
            return a.line - b.line;
          return a.name.localeCompare(b.name);
        }),
      }));
      return [
        {
          eventId,
          fixtureDate: fixture.fixtureDate,
          leagueId: String(fixture.leagueId).toLowerCase(),
          leagueName: this.resolveLeagueName(
            league,
            competition,
            String(fixture.leagueId ?? ''),
          ),
          country: league?.country ?? null,
          leaguePriority: league?.priority ?? 'SELECTIVE',
          isPriorityLeague: league?.isPriority === true,
          homeTeam: teamName(
            homeCompetitor,
            String(fixture.homeTeamId ?? 'Home'),
          ),
          awayTeam: teamName(
            awayCompetitor,
            String(fixture.awayTeamId ?? 'Away'),
          ),
          markets,
          pricedSelectionCount: fixturePrices.length,
        },
      ];
    });

    return { items, count: items.length, from, to, readOnly: true };
  }

  private resolveLeagueName(
    league: any,
    competition: any,
    leagueId: string,
  ): string {
    const candidates = [
      competition?.displayName,
      competition?.name,
      competition?.shortName,
      league?.payload?.displayName,
      league?.payload?.name,
      league?.name,
    ];
    const isCode = (value: string) =>
      /^[a-z0-9]+(?:[._][a-z0-9]+)+$/i.test(value);
    for (const candidate of candidates) {
      const value = String(candidate ?? '').trim();
      if (
        value &&
        value.toLowerCase() !== leagueId.toLowerCase() &&
        !isCode(value)
      )
        return value;
    }
    return 'League name unavailable';
  }

  private parseDate(value: string | undefined, field: string): Date {
    if (!value) throw new BadRequestException(`${field} is required`);
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()))
      throw new BadRequestException(`${field} must be a valid ISO date`);
    return date;
  }

  private selectionLabel(key: string, line?: number): string {
    const normalized = key.toUpperCase();
    if (normalized.startsWith('OVER_'))
      return `Over ${line ?? this.lineFromKey(key) ?? ''}`.trim();
    if (normalized.startsWith('UNDER_'))
      return `Under ${line ?? this.lineFromKey(key) ?? ''}`.trim();
    const known: Record<string, string> = {
      HOME_WIN: 'Home win',
      DRAW: 'Draw',
      AWAY_WIN: 'Away win',
      HOME_OR_DRAW: 'Home or draw',
      HOME_OR_AWAY: 'Home or away',
      DRAW_OR_AWAY: 'Draw or away',
      HOME: 'Home',
      AWAY: 'Away',
      YES: 'Yes',
      NO: 'No',
    };
    return (
      known[normalized] ??
      key
        .replace(/_/g, ' ')
        .toLowerCase()
        .replace(/\b\w/g, (char) => char.toUpperCase())
    );
  }

  private lineFromKey(key: string): number | undefined {
    const match = key.match(/_(\d+)(?:_(\d+))?$/);
    if (!match) return undefined;
    return Number(`${match[1]}${match[2] ? `.${match[2]}` : ''}`);
  }
}

