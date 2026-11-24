import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';

import type {
  SportsCompetitionRegion,
  SportsCompetitionType,
  SportsFixtureState,
} from '../interfaces/sports-domain.interface';
import type { SportsFixtureQuery } from '../interfaces/sports-read.interface';
import { SportsDomainReadService } from '../services/sports-domain-read.service';

const FIXTURE_STATES: SportsFixtureState[] = [
  'SCHEDULED', 'LIVE', 'HALFTIME', 'EXTRA_TIME', 'PENALTIES',
  'COMPLETED', 'POSTPONED', 'CANCELLED', 'ABANDONED', 'UNKNOWN',
];

/** Provider-independent read endpoints over normalized ESPN facts only. */
@Controller('sports/v2')
export class SportsDomainReadController {
  constructor(private readonly read: SportsDomainReadService) {}

  @Get('competitions')
  getCompetitions(
    @Query('activeOnly') activeOnly?: string,
    @Query('region') region?: string,
    @Query('type') type?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
  ) {
    return this.read.getCompetitions({
      activeOnly: activeOnly === undefined ? true : activeOnly !== 'false',
      region: this.parseEnum(region, ['NIGERIA', 'AFRICA', 'EUROPE', 'SOUTH_AMERICA', 'NORTH_AMERICA', 'ASIA', 'OCEANIA', 'WORLD'], 'region') as SportsCompetitionRegion | undefined,
      type: this.parseEnum(type, ['LEAGUE', 'CLUB_COMPETITION', 'INTERNATIONAL'], 'type') as SportsCompetitionType | undefined,
      search,
      limit: this.parseInteger(limit, 'limit'),
    });
  }

  @Get('competitions/:competitionId')
  getCompetition(@Param('competitionId') id: string) {
    return this.read.getCompetition(id);
  }

  @Get('competitions/:competitionId/seasons')
  getSeasons(@Param('competitionId') id: string) {
    return this.read.getSeasons(id);
  }

  @Get('teams')
  getTeams(
    @Query('leagueId') leagueId?: string,
    @Query('country') country?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
  ) {
    return this.read.getTeams({ leagueId, country, search, limit: this.parseInteger(limit, 'limit') });
  }

  /** Resolve a bounded set of fixture team IDs with one normalized database read. */
  @Post('teams/lookup')
  lookupTeams(@Body('ids') ids: unknown) {
    if (!Array.isArray(ids)) {
      throw new BadRequestException('ids must be an array of team identifiers.');
    }
    if (ids.length > 1_000) {
      throw new BadRequestException('A maximum of 1000 team identifiers can be resolved per request.');
    }

    const identifiers = [...new Set(ids.map((value) => {
      if (typeof value !== 'string' && typeof value !== 'number') {
        throw new BadRequestException('Every team identifier must be a string or number.');
      }
      const id = String(value).trim();
      if (!id || id.length > 128) {
        throw new BadRequestException('Team identifiers must contain between 1 and 128 characters.');
      }
      return id;
    }))];

    return identifiers.length ? this.read.getTeamsByIdentifiers(identifiers) : [];
  }

  @Get('teams/:teamId')
  getTeam(@Param('teamId') id: string) {
    return this.read.getTeam(id);
  }

  @Get('seasons/:seasonId')
  getSeason(@Param('seasonId') id: string) {
    return this.read.getSeason(id);
  }

  @Get('fixtures')
  getFixtures(
    @Query('competitionId') competitionId?: string,
    @Query('seasonId') seasonId?: string,
    @Query('teamId') teamId?: string,
    @Query('state') state?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const query: SportsFixtureQuery = {
      competitionId,
      seasonId,
      teamId,
      state: this.parseEnum(state, FIXTURE_STATES, 'state') as SportsFixtureState | undefined,
      from: this.parseDate(from, 'from'),
      to: this.parseDate(to, 'to'),
      limit: this.parseInteger(limit, 'limit'),
      cursor,
    };
    if (query.from && query.to && query.from > query.to) {
      throw new BadRequestException('from must be earlier than or equal to to.');
    }
    return this.read.getFixtures(query);
  }

  @Get('fixtures/:fixtureId')
  getMatch(@Param('fixtureId') id: string) {
    return this.read.getMatch(id);
  }

  @Get('fixtures/:fixtureId/timeline')
  getTimeline(@Param('fixtureId') id: string) {
    return this.read.getMatchTimeline(id);
  }

  @Get('fixtures/:fixtureId/odds')
  getOdds(
    @Param('fixtureId') id: string,
    @Query('history') history?: string,
    @Query('limit') limit?: string,
  ) {
    if (history === 'true') return this.read.getMatchOddsHistory(id, this.parseInteger(limit, 'limit') ?? 20);
    return this.read.getMatchOdds(id);
  }

  private parseEnum<T extends string>(value: string | undefined, allowed: readonly T[], field: string): T | undefined {
    if (!value) return undefined;
    const normalized = value.trim().toUpperCase() as T;
    if (!allowed.includes(normalized)) throw new BadRequestException(`Unsupported ${field}: ${value}`);
    return normalized;
  }

  private parseInteger(value: string | undefined, field: string): number | undefined {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) throw new BadRequestException(`${field} must be a positive integer.`);
    return parsed;
  }

  private parseDate(value: string | undefined, field: string): Date | undefined {
    if (!value) return undefined;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new BadRequestException(`Invalid ${field} date.`);
    return parsed;
  }
}
