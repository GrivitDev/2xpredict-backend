import {
  BadRequestException,
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { SportsDomainReadService } from '../../sports/services/sports-domain-read.service';
import {
  FOOTBALL_MARKET_BY_ID,
  FOOTBALL_MARKET_CATALOG,
  expandCanonicalSelections,
} from '../catalog/football-market-catalog';
import { OddsService } from '../services/odds.service';
import type { OddsQuoteSnapshot } from '../services/odds.service';
import { OddsMonitorService } from '../services/odds-monitor.service';

const MAX_RANGE_DAYS = 8;
const MAX_FIXTURES = 500;

@Controller('odds/admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class OddsCenterController {
  constructor(
    private readonly sportsRead: SportsDomainReadService,
    private readonly oddsService: OddsService,
    private readonly oddsMonitorService: OddsMonitorService,
  ) {}

  /** Admin-only operational snapshot; refresh=true bypasses its short cache. */
  @Get('monitor')
  getOddsMonitor(@Query('refresh') refresh?: string) {
    return this.oddsMonitorService.getOverview(refresh === 'true');
  }

  /** Read-only Odds center. All fixture/team/competition data is read from Sports. */
  @Get('center')
  async getOddsCenter(
    @Query('from') fromValue?: string,
    @Query('to') toValue?: string,
  ) {
    const from = this.parseDate(fromValue, 'from');
    const to = this.parseDate(toValue, 'to');
    if (to <= from)
      throw new BadRequestException('to must be later than from');
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86_400_000)
      throw new BadRequestException(
        `Date range cannot exceed ${MAX_RANGE_DAYS} days`,
      );

    const fixtures: any[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.sportsRead.getFixtures({
        from,
        to,
        limit: Math.min(200, MAX_FIXTURES - fixtures.length),
        cursor,
      });
      fixtures.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor && fixtures.length < MAX_FIXTURES);

    const eventIds = fixtures.map((fixture) => fixture.id);
    const [prices, competitions, teams] = await Promise.all([
      this.oddsService.getPricesForFixtures(eventIds),
      Promise.all(
        [...new Set(fixtures.map((fixture) => fixture.competitionId))].map(
          (id) => this.sportsRead.getCompetition(id),
        ),
      ),
      Promise.all(
        [
          ...new Set(
            fixtures.flatMap((fixture) =>
              fixture.competitors.map((item: any) => item.teamId),
            ),
          ),
        ].map((id) => this.sportsRead.getTeam(id)),
      ),
    ]);
    const competitionById = new Map(
      competitions.filter(Boolean).map((item: any) => [item.id, item]),
    );
    const teamById = new Map(
      teams.filter(Boolean).map((item: any) => [item.id, item]),
    );
    const pricesByEvent = new Map<string, OddsQuoteSnapshot[]>();
    for (const price of prices) {
      const list = pricesByEvent.get(price.eventId) ?? [];
      list.push(price);
      pricesByEvent.set(price.eventId, list);
    }

    const items = fixtures.map((fixture) => {
      const home = fixture.competitors.find(
        (item: any) => item.homeAway === 'HOME',
      );
      const away = fixture.competitors.find(
        (item: any) => item.homeAway === 'AWAY',
      );
      const homeTeam = home ? (teamById.get(home.teamId) as any) : null;
      const awayTeam = away ? (teamById.get(away.teamId) as any) : null;
      const competition = competitionById.get(fixture.competitionId) as any;
      const fixturePrices = pricesByEvent.get(fixture.id) ?? [];
      const grouped = new Map<string, any>();

      for (const price of fixturePrices) {
        const definition = FOOTBALL_MARKET_BY_ID.get(price.marketId);
        if (!definition) continue;
        const market = grouped.get(definition.id) ?? {
          id: definition.id,
          name: definition.fullName,
          abbreviation: definition.abbreviation,
          family: definition.family,
          model: definition.model,
          selections: [],
        };
        const templates = expandCanonicalSelections(
          definition,
          homeTeam?.displayName ?? homeTeam?.name ?? 'Home',
          awayTeam?.displayName ?? awayTeam?.name ?? 'Away',
        );
        const selection = templates.find(
          (item) => item.key === price.selectionKey,
        );
        market.selections.push({
          key: price.selectionKey,
          name:
            selection?.fullName ?? price.selectionKey.replace(/_/g, ' '),
          line: price.line,
          odds: price.decimalOdds,
          source: price.priceType,
          pricingSource: price.pricingSource ?? null,
          provider: price.provider ?? null,
          bookmaker: price.bookmaker ?? (price.pricingSource === 'GRIVIT_MODEL' ? 'Grivit' : null),
          fairOdds: price.fairOdds ?? null,
          fairProbability: price.fairProbability ?? null,
          marketFairOdds: price.marketFairOdds ?? null,
          externalBookmakerCount: price.externalBookmakerCount ?? 0,
          externalConsensusFairOdds: price.externalConsensusFairOdds ?? null,
          externalConsensusProbability: price.externalConsensusProbability ?? null,
          externalDeviationPercent: price.externalDeviationPercent ?? null,
          externalValidatedAt: price.externalValidatedAt ?? null,
          externalValidationStatus: price.externalValidationStatus ?? 'NO_EXTERNAL_REFERENCE',
          impliedProbability: price.impliedProbability ?? null,
          valuePercent: price.valuePercent ?? null,
          predictionReady: price.predictionReady,
          dataQuality: price.dataQuality ?? 0,
          sampleSize: price.sampleSize ?? 0,
          providerUpdatedAt: price.providerUpdatedAt ?? null,
          oddsCapturedAt: price.oddsCapturedAt,
          oddsFreshUntil: price.oddsFreshUntil,
          isFresh: price.isFresh,
          calculationVersion: price.calculationVersion ?? null,
        });
        grouped.set(definition.id, market);
      }

      const markets = [...grouped.values()].map((market) => ({
        ...market,
        selections: market.selections.sort((a: any, b: any) => {
          if (
            a.line !== undefined &&
            b.line !== undefined &&
            a.line !== b.line
          )
            return a.line - b.line;
          return a.name.localeCompare(b.name);
        }),
      }));

      return {
        eventId: fixture.id,
        fixtureId: fixture.id,
        kickoffAt: fixture.kickoffAt,
        status: fixture.status,
        competitionId: fixture.competitionId,
        competitionName:
          competition?.displayName ??
          competition?.name ??
          'Competition unavailable',
        competitionRegion: competition?.region ?? null,
        homeTeam:
          homeTeam?.displayName ?? homeTeam?.name ?? home?.teamId ?? 'Home',
        awayTeam:
          awayTeam?.displayName ?? awayTeam?.name ?? away?.teamId ?? 'Away',
        markets,
        pricedSelectionCount: fixturePrices.length,
        predictionReadySelectionCount: fixturePrices.filter(
          (item) => item.predictionReady,
        ).length,
      };
    });

    return {
      items,
      count: items.length,
      from,
      to,
      readOnly: true,
      dataSource: 'SPORTS_MODULE',
      externalApiCalls: 0,
      catalogueMarketCount: FOOTBALL_MARKET_CATALOG.length,
      truncated: fixtures.length >= MAX_FIXTURES,
    };
  }

  private parseDate(value: string | undefined, label: string): Date {
    if (!value) throw new BadRequestException(`${label} is required`);
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()))
      throw new BadRequestException(`${label} must be a valid ISO date`);
    return date;
  }
}
