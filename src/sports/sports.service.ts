import { Injectable } from '@nestjs/common';

import { SportsDataFilter } from './interfaces/sports-data-filter.interface';
import { SportsDataReadService } from './services/sports-data-read.service';

@Injectable()
export class SportsService {
  constructor(private readonly sportsDataReadService: SportsDataReadService) {}

  async getLive(filters: SportsDataFilter = {}) {
    return this.sportsDataReadService.getLiveFixtures(filters);
  }

  async getFixtures(filters: SportsDataFilter = {}) {
    return this.sportsDataReadService.getUpcomingFixtures(filters);
  }

  async getResults(filters: SportsDataFilter = {}) {
    return this.sportsDataReadService.getFinishedFixtures(filters);
  }

  async getStandings(competitionId: string, teamId?: string, groupId?: string) {
    return this.sportsDataReadService.getLeagueTable(
      competitionId,
      teamId,
      groupId,
    );
  }

  async getCompetitions(options?: {
    activeOnly?: boolean;
    predictionEnabled?: boolean;
  }) {
    return this.sportsDataReadService.getCompetitions(options);
  }

  async getTeams(competitionId: string, teamId?: string) {
    return this.sportsDataReadService.getTeams(competitionId, teamId);
  }

  async getActiveCompetitions() {
    return this.sportsDataReadService.getActiveCompetitions();
  }
}
