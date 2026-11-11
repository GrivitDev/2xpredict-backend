import { BadRequestException, Controller, Get, Query, Param } from '@nestjs/common';
import { SportsDerivedProjectionService } from '../services/sports-derived-projection.service';

/** Read surface for reusable, event-triggered football projections. */
@Controller('sports/v2')
export class SportsDerivedReadController {
  constructor(private readonly derived: SportsDerivedProjectionService) {}

  @Get('competitions/:competitionId/standings')
  getStandings(@Param('competitionId') competitionId: string, @Query('seasonId') seasonId?: string) {
    return this.derived.getStandings(competitionId, this.required(seasonId, 'seasonId'));
  }

  @Get('competitions/:competitionId/scoring')
  getCompetitionScoring(@Param('competitionId') competitionId: string, @Query('seasonId') seasonId?: string) {
    return this.derived.getCompetitionScoring(competitionId, this.required(seasonId, 'seasonId'));
  }

  @Get('teams/:teamId/form')
  getTeamForm(@Param('teamId') teamId: string, @Query('competitionId') competitionId?: string, @Query('seasonId') seasonId?: string) {
    return this.derived.getTeamForm(teamId, this.required(competitionId, 'competitionId'), this.required(seasonId, 'seasonId'));
  }

  @Get('teams/:teamId/home-away')
  getTeamHomeAway(@Param('teamId') teamId: string, @Query('competitionId') competitionId?: string, @Query('seasonId') seasonId?: string) {
    return this.derived.getTeamHomeAway(teamId, this.required(competitionId, 'competitionId'), this.required(seasonId, 'seasonId'));
  }

  @Get('teams/:teamId/scoring')
  getTeamScoring(@Param('teamId') teamId: string, @Query('competitionId') competitionId?: string, @Query('seasonId') seasonId?: string) {
    return this.derived.getTeamScoring(teamId, this.required(competitionId, 'competitionId'), this.required(seasonId, 'seasonId'));
  }

  @Get('teams/:teamId/statistics')
  getTeamStatistics(@Param('teamId') teamId: string, @Query('competitionId') competitionId?: string, @Query('seasonId') seasonId?: string) {
    return this.derived.getTeamStatistics(teamId, this.required(competitionId, 'competitionId'), this.required(seasonId, 'seasonId'));
  }

  @Get('head-to-head')
  getHeadToHead(@Query('teamAId') teamAId?: string, @Query('teamBId') teamBId?: string, @Query('competitionId') competitionId?: string) {
    return this.derived.getHeadToHead(this.required(teamAId, 'teamAId'), this.required(teamBId, 'teamBId'), this.required(competitionId, 'competitionId'));
  }

  @Get('players/:playerId/event-totals')
  getPlayerEventTotals(@Param('playerId') playerId: string, @Query('competitionId') competitionId?: string, @Query('seasonId') seasonId?: string) {
    return this.derived.getPlayerEventTotals(playerId, this.required(competitionId, 'competitionId'), this.required(seasonId, 'seasonId'));
  }

  private required(value: string | undefined, field: string): string {
    const normalized = String(value ?? '').trim();
    if (!normalized) throw new BadRequestException(`${field} is required.`);
    return normalized;
  }
}
