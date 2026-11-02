import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';

import axios, { AxiosError, AxiosInstance } from 'axios';

import {
  FootballDataCompetition,
  FootballDataCompetitionListResponse,
  FootballDataMatchListResponse,
  FootballDataStandingsResponse,
  FootballDataTeamListResponse,
} from './football-data.interfaces';

import { SportsProviderRateLimitService } from '../services/sports-provider-rate-limit.service';
import { SPORTS_DATA_COLLECTION_CONFIG } from '../config/sports-data-collection.config';

export interface FootballDataMatchQuery {
  competitions?: string;

  dateFrom?: string;

  dateTo?: string;

  season?: number;

  status?: string;

  stage?: string;

  group?: string;

  matchday?: number;

  limit?: number;
}

@Injectable()
export class FootballDataService implements OnModuleInit {
  private readonly logger = new Logger(FootballDataService.name);

  private readonly baseUrl = 'https://api.football-data.org/v4';

  private readonly apiKey = process.env.FOOTBALL_DATA_API_KEY?.trim();

  private readonly client: AxiosInstance;

  constructor(
    private readonly providerRateLimitService: SportsProviderRateLimitService,
  ) {
    this.client = axios.create({
      baseURL: this.baseUrl,

      timeout: 15_000,

      headers: {
        Accept: 'application/json',
        'X-Unfold-Goals': 'true',

        ...(this.apiKey
          ? {
              'X-Auth-Token': this.apiKey,
            }
          : {}),
      },
    });
  }

  onModuleInit(): void {
    if (!this.isEnabled()) {
      this.logger.log(
        'Football-Data.org disabled by default; set SPORTS_ENABLE_FOOTBALL_DATA=true for emergency use',
      );
      return;
    }
    if (!this.apiKey) {
      this.logger.warn('FOOTBALL_DATA_API_KEY is not configured');

      return;
    }

    this.logger.log('Football-Data.org provider initialized');
  }

  // ============================================================
  // COMPETITIONS
  // ============================================================

  async getCompetitions(): Promise<FootballDataCompetitionListResponse> {
    return this.request<FootballDataCompetitionListResponse>(
      '/competitions',
      'competitions',
    );
  }

  async getCompetition(
    competitionCode: string,
  ): Promise<FootballDataCompetition> {
    const code = this.normalizeCompetitionCode(competitionCode);

    return this.request<FootballDataCompetition>(
      `/competitions/${code}`,
      'competition',
    );
  }

  // ============================================================
  // MATCHES
  // ============================================================

  /**
   * Global matches endpoint.
   *
   * All query variations use the same "matches"
   * rate-limit slot.
   */
  async getMatches(
    query: FootballDataMatchQuery = {},
  ): Promise<FootballDataMatchListResponse> {
    return this.request<FootballDataMatchListResponse>('/matches', 'matches', {
      params: this.cleanQuery(query),
    });
  }

  /**
   * Competition-scoped matches endpoint.
   *
   * All competition-specific requests use the same
   * "competition-matches" endpoint slot.
   */
  async getCompetitionMatches(
    competitionCode: string,
    query: Omit<FootballDataMatchQuery, 'competitions'> = {},
  ): Promise<FootballDataMatchListResponse> {
    const code = this.normalizeCompetitionCode(competitionCode);

    return this.request<FootballDataMatchListResponse>(
      `/competitions/${code}/matches`,
      'competition-matches',
      {
        params: this.cleanQuery(query),
      },
    );
  }

  // ============================================================
  // LIVE MATCHES
  // ============================================================

  async getLiveMatches(
    competitions?: string[],
  ): Promise<FootballDataMatchListResponse> {
    const competitionFilter = this.normalizeCompetitionList(competitions);

    return this.getMatches({
      ...(competitionFilter
        ? {
            competitions: competitionFilter,
          }
        : {}),

      status: 'IN_PLAY,PAUSED',
    });
  }

  // ============================================================
  // SCHEDULED MATCHES
  // ============================================================

  async getScheduledMatches(
    competitions?: string[],
    dateFrom?: string,
    dateTo?: string,
  ): Promise<FootballDataMatchListResponse> {
    return this.getMatches({
      competitions: this.normalizeCompetitionList(competitions),

      dateFrom,

      dateTo,

      status: 'SCHEDULED,TIMED',
    });
  }

  // ============================================================
  // FINISHED MATCHES
  // ============================================================

  async getFinishedMatches(
    competitions?: string[],
    dateFrom?: string,
    dateTo?: string,
  ): Promise<FootballDataMatchListResponse> {
    return this.getMatches({
      competitions: this.normalizeCompetitionList(competitions),

      dateFrom,

      dateTo,

      status: 'FINISHED',
    });
  }

  // ============================================================
  // STANDINGS
  // ============================================================

  async getStandings(
    competitionCode: string,
    season?: number,
  ): Promise<FootballDataStandingsResponse> {
    const code = this.normalizeCompetitionCode(competitionCode);

    return this.request<FootballDataStandingsResponse>(
      `/competitions/${code}/standings`,
      'standings',
      {
        params:
          season === undefined
            ? undefined
            : {
                season: this.validatePositiveInteger(season, 'season'),
              },
      },
    );
  }

  // ============================================================
  // TEAMS
  // ============================================================

  async getTeams(
    competitionCode: string,
    season?: number,
  ): Promise<FootballDataTeamListResponse> {
    const code = this.normalizeCompetitionCode(competitionCode);

    return this.request<FootballDataTeamListResponse>(
      `/competitions/${code}/teams`,
      'teams',
      {
        params:
          season === undefined
            ? undefined
            : {
                season: this.validatePositiveInteger(season, 'season'),
              },
      },
    );
  }

  private isEnabled(): boolean {
    return (
      SPORTS_DATA_COLLECTION_CONFIG.FOOTBALL_DATA.enabled ||
      process.env.SPORTS_ENABLE_FOOTBALL_DATA === 'true'
    );
  }

  // ============================================================
  // REQUEST
  // ============================================================

  private async request<T>(
    path: string,
    rateLimitEndpoint: string,
    config: {
      params?: Record<string, string | number>;
    } = {},
  ): Promise<T> {
    if (!this.isEnabled()) {
      throw new ServiceUnavailableException(
        'Football-Data.org is disabled; set SPORTS_ENABLE_FOOTBALL_DATA=true for emergency use',
      );
    }
    if (!this.apiKey) {
      throw new ServiceUnavailableException(
        'Football-Data.org API key is not configured',
      );
    }

    return this.providerRateLimitService.execute(
      'football-data',
      rateLimitEndpoint,
      async () => {
        try {
          const response = await this.client.get<T>(path, config);

          return response.data;
        } catch (error) {
          return this.handleRequestError(error, path);
        }
      },
    );
  }

  // ============================================================
  // QUERY CLEANING
  // ============================================================

  private cleanQuery(
    query: FootballDataMatchQuery,
  ): Record<string, string | number> {
    const params: Record<string, string | number> = {};

    if (query.competitions?.trim()) {
      const competitions = this.normalizeCompetitionList(
        query.competitions.split(','),
      );

      if (competitions) {
        params.competitions = competitions;
      }
    }

    if (query.dateFrom) {
      this.validateDate(query.dateFrom, 'dateFrom');

      params.dateFrom = query.dateFrom;
    }

    if (query.dateTo) {
      this.validateDate(query.dateTo, 'dateTo');

      params.dateTo = query.dateTo;
    }

    if (query.dateFrom && query.dateTo && query.dateFrom > query.dateTo) {
      throw new BadRequestException('dateFrom cannot be after dateTo');
    }

    if (query.season !== undefined) {
      params.season = this.validatePositiveInteger(query.season, 'season');
    }

    if (query.status?.trim()) {
      params.status = query.status.trim().toUpperCase();
    }

    if (query.stage?.trim()) {
      params.stage = query.stage.trim().toUpperCase();
    }

    if (query.group?.trim()) {
      params.group = query.group.trim();
    }

    if (query.matchday !== undefined) {
      params.matchday = this.validatePositiveInteger(
        query.matchday,
        'matchday',
      );
    }

    if (query.limit !== undefined) {
      params.limit = this.validatePositiveInteger(query.limit, 'limit');
    }

    return params;
  }

  // ============================================================
  // NORMALIZATION
  // ============================================================

  private normalizeCompetitionCode(code: string): string {
    const normalized = code.trim().toUpperCase();

    if (!normalized) {
      throw new BadRequestException(
        'Football-Data competition code is required',
      );
    }

    return encodeURIComponent(normalized);
  }

  private normalizeCompetitionList(
    competitions?: string[],
  ): string | undefined {
    const values = competitions
      ?.map((competition) => competition.trim().toUpperCase())
      .filter(Boolean);

    if (!values?.length) {
      return undefined;
    }

    return values.join(',');
  }

  // ============================================================
  // VALIDATION
  // ============================================================

  private validatePositiveInteger(value: number, field: string): number {
    if (!Number.isInteger(value) || value <= 0) {
      throw new BadRequestException(`${field} must be a positive integer`);
    }

    return value;
  }

  private validateDate(value: string, field: string): void {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new BadRequestException(`${field} must be a valid YYYY-MM-DD date`);
    }

    const date = new Date(`${value}T00:00:00.000Z`);

    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(`${field} must be a valid YYYY-MM-DD date`);
    }
  }

  // ============================================================
  // ERROR HANDLING
  // ============================================================

  private handleRequestError(error: unknown, path: string): never {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError<{
        message?: string;
      }>;

      const status = axiosError.response?.status;

      const message =
        axiosError.response?.data?.message ??
        axiosError.message ??
        'Unknown Football-Data.org error';

      this.logger.error(
        `Football-Data request failed: ${path} ` +
          `(${status ?? 'network'}) - ${message}`,
      );

      throw new ServiceUnavailableException(
        `Football-Data.org request failed${
          status ? ` with status ${status}` : ''
        }`,
      );
    }

    this.logger.error(`Football-Data request failed: ${path}`);

    throw new ServiceUnavailableException('Football-Data.org request failed');
  }
}
