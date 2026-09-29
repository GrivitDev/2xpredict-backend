import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';

import { SportsDataReadService } from './services/sports-data-read.service';
import { SportsSystemMonitorService } from './services/sports-system-monitor.service';

import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

import { SportsSystemMonitorResponse } from './interfaces/sports-system-monitor.interface';

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
  async getCompetition(
    @Param('competitionId') competitionId: string,
    @Query('season') season?: string,
  ) {
    return this.sportsDataReadService.getCompetition(
      competitionId,
      season ? Number(season) : undefined,
    );
  }

  @Get('fixtures/upcoming')
  async getUpcomingFixtures(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('competitionId') competitionId?: string,
  ) {
    return this.sportsDataReadService.getUpcomingFixtures(
      from ? new Date(from) : undefined,
      to ? new Date(to) : undefined,
      competitionId,
    );
  }

  @Get('fixtures/live')
  async getLiveFixtures(@Query('competitionId') competitionId?: string) {
    return this.sportsDataReadService.getLiveFixtures(competitionId);
  }

  @Get('fixtures/finished')
  async getFinishedFixtures(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('competitionId') competitionId?: string,
  ) {
    return this.sportsDataReadService.getFinishedFixtures(
      from ? new Date(from) : undefined,
      to ? new Date(to) : undefined,
      competitionId,
    );
  }

  @Get('fixtures/:eventId/summary')
  async getFixtureSummary(@Param('eventId') eventId: string) {
    return this.sportsDataReadService.getFixtureSummary(eventId);
  }

  @Get('competitions/:competitionId/table')
  async getLeagueTable(
    @Param('competitionId') competitionId: string,
    @Query('season') season?: string,
  ) {
    return this.sportsDataReadService.getLeagueTable(
      competitionId,
      season ? Number(season) : undefined,
    );
  }

  @Get('competitions/:competitionId/teams')
  async getTeams(@Param('competitionId') competitionId: string) {
    return this.sportsDataReadService.getTeams(competitionId);
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
  async getAdminSystemMonitor(
    @Query('leagueId') leagueId?: string,
  ): Promise<SportsSystemMonitorResponse> {
    return this.sportsSystemMonitorService.getSystemMonitor({
      leagueId,
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
  // ADMIN: ESPN LEAGUES
  // PUBLIC ACCESS
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
  // ADMIN: ESPN LIVE MATCHES
  // PUBLIC ACCESS
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
  // ADMIN: ESPN NEWS
  // PUBLIC ACCESS
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
  // ADMIN: ESPN STANDINGS
  // PUBLIC ACCESS
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
  // ADMIN: ESPN TEAMS
  // PUBLIC ACCESS
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
  // ADMIN: YOUTUBE HIGHLIGHTS
  // PUBLIC ACCESS
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
}
