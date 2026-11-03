import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';

import { SportsDataReadService } from './services/sports-data-read.service';
import { SportsSystemMonitorService } from './services/sports-system-monitor.service';

import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

import type { SportsSystemMonitorResponse } from './interfaces/sports-system-monitor.interface';
import { SportsDataFilter } from './interfaces/sports-data-filter.interface';

import type { Response } from 'express';

@Controller('sports')
export class SportsController {
  constructor(
    private readonly sportsDataReadService: SportsDataReadService,
    private readonly sportsSystemMonitorService: SportsSystemMonitorService,
  ) {}

  // ============================================================
  // PUBLIC / APPLICATION SPORTS DATA
  // ============================================================

  @Get('competitions')
  async getCompetitions(
    @Query('activeOnly') activeOnly?: string,
    @Query('predictionEnabled') predictionEnabled?: string,
  ) {
    return this.sportsDataReadService.getCompetitions({
      activeOnly: activeOnly === 'true',
      predictionEnabled: predictionEnabled === 'true',
    });
  }

  @Get('competitions/:competitionId')
  async getCompetition(@Param('competitionId') competitionId: string) {
    return this.sportsDataReadService.getCompetition(competitionId);
  }

  @Get('competitions/:competitionId/standings')
  async getCompetitionStandings(
    @Param('competitionId') competitionId: string,
    @Query('teamId') teamId?: string,
    @Query('groupId') groupId?: string,
  ) {
    return this.sportsDataReadService.getLeagueTable(
      competitionId,
      teamId,
      groupId,
    );
  }

  @Get('competitions/:competitionId/teams')
  async getCompetitionTeams(
    @Param('competitionId') competitionId: string,
    @Query('teamId') teamId?: string,
  ) {
    return this.sportsDataReadService.getTeams(competitionId, teamId);
  }

  @Get('fixtures/upcoming')
  async getUpcomingFixtures(
    @Query('date') date?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('competitionId') competitionId?: string,
    @Query('teamId') teamId?: string,
  ) {
    return this.sportsDataReadService.getUpcomingFixtures(
      this.buildSportsDataFilter({
        date,
        from,
        to,
        competitionId,
        teamId,
      }),
    );
  }

  @Get('fixtures/live')
  async getLiveFixtures(
    @Query('date') date?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('competitionId') competitionId?: string,
    @Query('teamId') teamId?: string,
  ) {
    return this.sportsDataReadService.getLiveFixtures(
      this.buildSportsDataFilter({
        date,
        from,
        to,
        competitionId,
        teamId,
      }),
    );
  }

  @Get('news-feed/stream')
  async streamFootballNews(
    @Query('competitionId') competitionId: string | undefined,
    @Query('teamId') teamId: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    response.status(200);
    response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');

    response.flushHeaders?.();

    try {
      for await (const item of this.sportsDataReadService.streamFootballNews(
        this.buildSportsDataFilter({
          competitionId,
          teamId,
        }),
      )) {
        if (response.writableEnded || response.destroyed) {
          break;
        }

        response.write(`${JSON.stringify({ type: 'item', item })}\n`);

        const flushableResponse = response as Response & {
          flush?: () => void;
        };

        flushableResponse.flush?.();
      }

      if (!response.writableEnded) {
        response.write(`${JSON.stringify({ type: 'complete' })}\n`);
        response.end();
      }
    } catch (error) {
      if (!response.writableEnded && !response.destroyed) {
        response.write(
          `${JSON.stringify({
            type: 'error',
            message: 'Football news stream failed.',
          })}\n`,
        );
        response.end();
      }

      throw error;
    }
  }

  @Get('news-feed')
  async getFootballNews(
    @Query('competitionId') competitionId?: string,
    @Query('teamId') teamId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedPage = page !== undefined ? Number(page) : 1;

    const parsedLimit = limit !== undefined ? Number(limit) : 30;

    if (!Number.isFinite(parsedPage) || parsedPage < 1) {
      throw new BadRequestException('Invalid page.');
    }

    if (!Number.isFinite(parsedLimit) || parsedLimit < 1) {
      throw new BadRequestException('Invalid limit.');
    }

    return this.sportsDataReadService.getFootballNews(
      this.buildSportsDataFilter({
        competitionId,
        teamId,
      }),
      parsedPage,
      parsedLimit,
    );
  }

  @Get('fixtures/finished')
  async getFinishedFixtures(
    @Query('date') date?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('competitionId') competitionId?: string,
    @Query('teamId') teamId?: string,
  ) {
    return this.sportsDataReadService.getFinishedFixtures(
      this.buildSportsDataFilter({
        date,
        from,
        to,
        competitionId,
        teamId,
      }),
    );
  }

  // ============================================================
  // PUBLIC / ESPN FIXTURE PAYLOAD
  // ============================================================

  @Get('fixtures/:eventId/id')
  async getFixtureId(@Param('eventId') eventId: string) {
    return this.sportsDataReadService.getFixtureId(eventId);
  }

  @Get('fixtures/:eventId/uid')
  async getFixtureUid(@Param('eventId') eventId: string) {
    return this.sportsDataReadService.getFixtureUid(eventId);
  }

  @Get('fixtures/:eventId/date')
  async getFixtureDate(@Param('eventId') eventId: string) {
    return this.sportsDataReadService.getFixtureDate(eventId);
  }

  @Get('fixtures/:eventId/name')
  async getFixtureName(@Param('eventId') eventId: string) {
    return this.sportsDataReadService.getFixtureName(eventId);
  }

  @Get('fixtures/:eventId/short-name')
  async getFixtureShortName(@Param('eventId') eventId: string) {
    return this.sportsDataReadService.getFixtureShortName(eventId);
  }

  @Get('fixtures/:eventId/time-valid')
  async getFixtureTimeValid(@Param('eventId') eventId: string) {
    return this.sportsDataReadService.getFixtureTimeValid(eventId);
  }

  @Get('fixtures/:eventId/season')
  async getFixtureSeason(@Param('eventId') eventId: string) {
    return this.sportsDataReadService.getFixtureSeason(eventId);
  }

  @Get('fixtures/:eventId/season-type')
  async getFixtureSeasonType(@Param('eventId') eventId: string) {
    return this.sportsDataReadService.getFixtureSeasonType(eventId);
  }

  @Get('fixtures/:eventId/competitions')
  async getFixtureCompetitions(@Param('eventId') eventId: string) {
    return this.sportsDataReadService.getFixtureCompetitions(eventId);
  }

  @Get('fixtures/:eventId/links')
  async getFixtureLinks(@Param('eventId') eventId: string) {
    return this.sportsDataReadService.getFixtureLinks(eventId);
  }

  @Get('fixtures/:eventId/league')
  async getFixtureLeague(@Param('eventId') eventId: string) {
    return this.sportsDataReadService.getFixtureLeague(eventId);
  }

  @Get('fixtures/:eventId/status')
  async getFixtureStatus(@Param('eventId') eventId: string) {
    return this.sportsDataReadService.getFixtureStatus(eventId);
  }

  @Get('fixtures/:eventId/venue')
  async getFixtureVenue(@Param('eventId') eventId: string) {
    return this.sportsDataReadService.getFixtureVenue(eventId);
  }

  // ============================================================
  // PUBLIC / ESPN MATCH SUMMARY
  // ============================================================

  @Get('fixtures/:eventId/summary/boxscore')
  async getFixtureSummaryBoxscore(@Param('eventId') eventId: string) {
    return this.sportsDataReadService.getFixtureSummaryBoxscore(eventId);
  }

  @Get('fixtures/:eventId/summary/format')
  async getFixtureSummaryFormat(@Param('eventId') eventId: string) {
    return this.sportsDataReadService.getFixtureSummaryFormat(eventId);
  }

  @Get('fixtures/:eventId/summary/game-info')
  async getFixtureSummaryGameInfo(@Param('eventId') eventId: string) {
    return this.sportsDataReadService.getFixtureSummaryGameInfo(eventId);
  }

  @Get('fixtures/:eventId/summary/last-five-games')
  async getFixtureSummaryLastFiveGames(@Param('eventId') eventId: string) {
    return this.sportsDataReadService.getFixtureSummaryLastFiveGames(eventId);
  }

  @Get('fixtures/:eventId/summary/broadcasts')
  async getFixtureSummaryBroadcasts(@Param('eventId') eventId: string) {
    return this.sportsDataReadService.getFixtureSummaryBroadcasts(eventId);
  }

  @Get('fixtures/:eventId/summary/pickcenter')
  async getFixtureSummaryPickcenter(@Param('eventId') eventId: string) {
    return this.sportsDataReadService.getFixtureSummaryPickcenter(eventId);
  }

  @Get('fixtures/:eventId/summary/odds')
  async getFixtureSummaryOdds(@Param('eventId') eventId: string) {
    return this.sportsDataReadService.getFixtureSummaryOdds(eventId);
  }

  @Get('fixtures/:eventId/summary/has-odds')
  async getFixtureSummaryHasOdds(@Param('eventId') eventId: string) {
    return this.sportsDataReadService.getFixtureSummaryHasOdds(eventId);
  }

  @Get('fixtures/:eventId/summary/rosters')
  async getFixtureSummaryRosters(@Param('eventId') eventId: string) {
    return this.sportsDataReadService.getFixtureSummaryRosters(eventId);
  }

  @Get('fixtures/:eventId/summary/news')
  async getFixtureSummaryNews(@Param('eventId') eventId: string) {
    return this.sportsDataReadService.getFixtureSummaryNews(eventId);
  }

  @Get('fixtures/:eventId/summary/season-series')
  async getFixtureSummarySeasonSeries(@Param('eventId') eventId: string) {
    return this.sportsDataReadService.getFixtureSummarySeasonSeries(eventId);
  }

  @Get('fixtures/:eventId/summary/videos')
  async getFixtureSummaryVideos(@Param('eventId') eventId: string) {
    return this.sportsDataReadService.getFixtureSummaryVideos(eventId);
  }

  @Get('fixtures/:eventId/summary/header')
  async getFixtureSummaryHeader(@Param('eventId') eventId: string) {
    return this.sportsDataReadService.getFixtureSummaryHeader(eventId);
  }

  @Get('fixtures/:eventId/summary/key-events')
  async getFixtureSummaryKeyEvents(@Param('eventId') eventId: string) {
    return this.sportsDataReadService.getFixtureSummaryKeyEvents(eventId);
  }

  @Get('fixtures/:eventId/summary/commentary')
  async getFixtureSummaryCommentary(@Param('eventId') eventId: string) {
    return this.sportsDataReadService.getFixtureSummaryCommentary(eventId);
  }

  @Get('fixtures/:eventId/summary/wallclock-available')
  async getFixtureSummaryWallclockAvailable(@Param('eventId') eventId: string) {
    return this.sportsDataReadService.getFixtureSummaryWallclockAvailable(
      eventId,
    );
  }

  @Get('fixtures/:eventId/summary/meta')
  async getFixtureSummaryMeta(@Param('eventId') eventId: string) {
    return this.sportsDataReadService.getFixtureSummaryMeta(eventId);
  }

  @Get('fixtures/:eventId/summary/standings')
  async getFixtureSummaryStandings(@Param('eventId') eventId: string) {
    return this.sportsDataReadService.getFixtureSummaryStandings(eventId);
  }

  // ============================================================
  // APPLICATION PROVIDER DATA
  // ============================================================

  @Get('odds/event/:eventId')
  async getOddsForEvent(@Param('eventId') eventId: string) {
    return this.sportsDataReadService.getOddsForEvent(eventId);
  }

  @Get('youtube/:fixtureId')
  async getYoutubeHighlight(@Param('fixtureId') fixtureId: string) {
    return this.sportsDataReadService.getYoutubeHighlight(fixtureId);
  }

  // ============================================================
  // ADMIN: SYSTEM MONITOR
  // ============================================================

  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get('admin/system-monitor')
  getAdminSystemMonitor(
    @Query('leagueId') leagueId?: string,
    @Query('forceRefresh') forceRefresh?: string,
  ): SportsSystemMonitorResponse {
    return this.sportsSystemMonitorService.getSystemMonitor({
      leagueId,
      forceRefresh: forceRefresh === 'true',
    });
  }

  // ============================================================
  // ADMIN: ACTIVE COMPETITIONS
  // PROTECTED
  // ============================================================

  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get('admin/active-competitions')
  async getAdminActiveCompetitions(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    @Query('competitionId') competitionId?: string,
    @Query('season') season?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: 'asc' | 'desc',
  ): Promise<unknown> {
    return this.sportsDataReadService.getAdminActiveCompetitions({
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      status,
      competitionId,
      season: season ? Number(season) : undefined,
      sortBy,
      sortOrder,
    });
  }

  // ============================================================
  // PUBLIC: ESPN LEAGUES
  // Raw provider records intentionally exposed to application users
  // ============================================================

  @Get('admin/espn/leagues')
  async getAdminEspnLeagues(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('leagueId') leagueId?: string,
    @Query('status') status?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: 'asc' | 'desc',
  ): Promise<unknown> {
    return this.sportsDataReadService.getAdminEspnLeagues({
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      leagueId,
      status,
      sortBy,
      sortOrder,
    });
  }

  // ============================================================
  // PUBLIC: ESPN LIVE MATCHES
  // Raw provider records intentionally exposed to application users
  // ============================================================

  @Get('admin/espn/live-matches')
  async getAdminEspnLiveMatches(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('leagueId') leagueId?: string,
    @Query('eventId') eventId?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: 'asc' | 'desc',
  ): Promise<unknown> {
    return this.sportsDataReadService.getAdminEspnLiveMatches({
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      leagueId,
      eventId,
      sortBy,
      sortOrder,
    });
  }

  // ============================================================
  // PUBLIC: ESPN NEWS
  // Raw provider records intentionally exposed to application users
  // ============================================================

  @Get('admin/espn/news')
  async getAdminEspnNews(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: 'asc' | 'desc',
  ): Promise<unknown> {
    return this.sportsDataReadService.getAdminEspnNews({
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      sortBy,
      sortOrder,
    });
  }

  // ============================================================
  // PUBLIC: ESPN STANDINGS
  // Raw provider records intentionally exposed to application users
  // ============================================================

  @Get('admin/espn/standings')
  async getAdminEspnStandings(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('leagueId') leagueId?: string,
    @Query('teamId') teamId?: string,
    @Query('season') season?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: 'asc' | 'desc',
  ): Promise<unknown> {
    return this.sportsDataReadService.getAdminEspnStandings({
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      leagueId,
      teamId,
      season: season ? Number(season) : undefined,
      sortBy,
      sortOrder,
    });
  }

  // ============================================================
  // PUBLIC: ESPN TEAMS
  // Raw provider records intentionally exposed to application users
  // ============================================================

  @Get('admin/espn/teams')
  async getAdminEspnTeams(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('leagueId') leagueId?: string,
    @Query('teamId') teamId?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: 'asc' | 'desc',
  ): Promise<unknown> {
    return this.sportsDataReadService.getAdminEspnTeams({
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      leagueId,
      teamId,
      sortBy,
      sortOrder,
    });
  }

  // ============================================================
  // ADMIN: ESPN QUEUES
  // PROTECTED
  // ============================================================

  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get('admin/espn/queues/summary')
  async getAdminEspnQueueSummary(): Promise<unknown> {
    return this.sportsDataReadService.getAdminEspnQueueSummary();
  }

  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get('admin/espn/queues')
  async getAdminEspnQueues(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('type') type?: string,
    @Query('status') status?: string,
    @Query('leagueId') leagueId?: string,
    @Query('eventId') eventId?: string,
    @Query('competitionId') competitionId?: string,
    @Query('season') season?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: 'asc' | 'desc',
  ): Promise<unknown> {
    return this.sportsDataReadService.getAdminEspnQueues({
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      type,
      status,
      leagueId,
      eventId,
      competitionId,
      season: season ? Number(season) : undefined,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      sortBy,
      sortOrder,
    });
  }

  // ============================================================
  // ADMIN: ESPN FIXTURES
  // PROTECTED
  // ============================================================

  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get('admin/espn/fixtures')
  async getAdminEspnFixtures(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('leagueId') leagueId?: string,
    @Query('eventId') eventId?: string,
    @Query('season') season?: string,
    @Query('teamId') teamId?: string,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: 'asc' | 'desc',
  ): Promise<unknown> {
    return this.sportsDataReadService.getAdminEspnFixtures({
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      leagueId,
      eventId,
      season: season ? Number(season) : undefined,
      teamId,
      status,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      sortBy,
      sortOrder,
    });
  }

  // ============================================================
  // ADMIN: FOOTBALL-DATA COMPETITIONS
  // PROTECTED
  // ============================================================

  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get('admin/football-data/competitions')
  async getAdminFootballDataCompetitions(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: 'asc' | 'desc',
  ): Promise<unknown> {
    return this.sportsDataReadService.getAdminFootballDataCompetitions({
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      sortBy,
      sortOrder,
    });
  }

  // ============================================================
  // ADMIN: FOOTBALL-DATA MATCHES
  // PROTECTED
  // ============================================================

  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get('admin/football-data/matches')
  async getAdminFootballDataMatches(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('competitionId') competitionId?: string,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: 'asc' | 'desc',
  ): Promise<unknown> {
    return this.sportsDataReadService.getAdminFootballDataMatches({
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      competitionId,
      status,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      sortBy,
      sortOrder,
    });
  }

  // ============================================================
  // ADMIN: FOOTBALL-DATA STANDINGS
  // PROTECTED
  // ============================================================

  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get('admin/football-data/standings')
  async getAdminFootballDataStandings(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('competitionId') competitionId?: string,
    @Query('season') season?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: 'asc' | 'desc',
  ): Promise<unknown> {
    return this.sportsDataReadService.getAdminFootballDataStandings({
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      competitionId,
      season: season ? Number(season) : undefined,
      sortBy,
      sortOrder,
    });
  }

  // ============================================================
  // ADMIN: FOOTBALL-DATA TEAMS
  // PROTECTED
  // ============================================================

  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get('admin/football-data/teams')
  async getAdminFootballDataTeams(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('competitionId') competitionId?: string,
    @Query('teamId') teamId?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: 'asc' | 'desc',
  ): Promise<unknown> {
    return this.sportsDataReadService.getAdminFootballDataTeams({
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      competitionId,
      teamId,
      sortBy,
      sortOrder,
    });
  }

  // ============================================================
  // ADMIN: ODDS API SPORTS
  // PROTECTED
  // ============================================================

  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get('admin/odds-api/sports')
  async getAdminOddsApiSports(
    @Query('provider') provider?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: 'asc' | 'desc',
  ): Promise<unknown> {
    return this.sportsDataReadService.getAdminOddsApiSports({
      provider,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      sortBy,
      sortOrder,
    });
  }

  // ============================================================
  // ADMIN: SPORTS ODDS SNAPSHOTS
  // PROTECTED
  // ============================================================

  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get('admin/odds-api/snapshots')
  async getAdminSportsOddsSnapshots(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('eventId') eventId?: string,
    @Query('provider') provider?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: 'asc' | 'desc',
  ): Promise<unknown> {
    return this.sportsDataReadService.getAdminSportsOddsSnapshots({
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      eventId,
      provider,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      sortBy,
      sortOrder,
    });
  }

  // ============================================================
  // ADMIN: PROVIDER RATE LIMITS
  // PROTECTED
  // ============================================================

  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get('admin/provider-rate-limits')
  async getAdminProviderRateLimits(
    @Query('provider') provider?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: 'asc' | 'desc',
  ): Promise<unknown> {
    return this.sportsDataReadService.getAdminProviderRateLimits({
      provider,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      sortBy,
      sortOrder,
    });
  }

  // ============================================================
  // PUBLIC: YOUTUBE HIGHLIGHTS
  // Raw provider records intentionally exposed to application users
  // ============================================================

  @Get('admin/youtube-highlights')
  async getAdminYoutubeHighlights(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    @Query('competitionId') competitionId?: string,
    @Query('eventId') eventId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: 'asc' | 'desc',
  ): Promise<unknown> {
    return this.sportsDataReadService.getAdminYoutubeHighlights({
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      status,
      competitionId,
      eventId,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      sortBy,
      sortOrder,
    });
  }

  // ============================================================
  // ADMIN: SPORTS SYNC STATES
  // PROTECTED
  // ============================================================

  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get('admin/sync-states')
  async getAdminSportsSyncStates(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('kind') kind?: string,
    @Query('type') type?: string,
    @Query('status') status?: string,
    @Query('stateKey') stateKey?: string,
    @Query('leagueId') leagueId?: string,
    @Query('season') season?: string,
    @Query('eventId') eventId?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: 'asc' | 'desc',
  ): Promise<unknown> {
    return this.sportsDataReadService.getAdminSportsSyncStates({
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      kind,
      type,
      status,
      stateKey,
      leagueId,
      season: season ? Number(season) : undefined,
      eventId,
      sortBy,
      sortOrder,
    });
  }

  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get('admin/sync-states/summary')
  async getAdminSportsSyncStateSummary(): Promise<unknown> {
    return this.sportsDataReadService.getAdminSportsSyncStateSummary();
  }

  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get('admin/sync-states/:stateKey')
  async getAdminSportsSyncState(
    @Param('stateKey') stateKey: string,
  ): Promise<unknown> {
    return this.sportsDataReadService.getAdminSportsSyncState(stateKey);
  }
  /**
   * Standard public sports filter parser.
   *
   * Use either:
   *   date=YYYY-MM-DD
   *
   * or:
   *   from=<ISO date>
   *   to=<ISO date>
   *
   * plus optional competitionId/teamId.
   */
  private buildSportsDataFilter(input: {
    date?: string;
    from?: string;
    to?: string;
    competitionId?: string;
    teamId?: string;
  }): SportsDataFilter {
    if (input.date && (input.from || input.to)) {
      throw new BadRequestException('Use either date or from/to, not both.');
    }

    const date = this.parseDate(input.date, 'date');
    const from = this.parseDate(input.from, 'from');
    const to = this.parseDate(input.to, 'to');

    if (from && to && from.getTime() >= to.getTime()) {
      throw new BadRequestException(
        'The from date must be earlier than the to date.',
      );
    }

    return {
      date,
      from,
      to,
      competitionId: input.competitionId?.trim() || undefined,
      teamId: input.teamId?.trim() || undefined,
    };
  }

  private parseDate(
    value: string | undefined,
    field: 'date' | 'from' | 'to',
  ): Date | undefined {
    if (!value?.trim()) {
      return undefined;
    }

    const parsed = new Date(value);

    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(
        `Invalid ${field} date. Use an ISO date or YYYY-MM-DD.`,
      );
    }

    return parsed;
  }
}

