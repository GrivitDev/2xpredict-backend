import { CompetitionPriority } from '../enums/competition-priority.enum';
import { CompetitionRegion } from '../enums/competition-region.enum';
import { CompetitionType } from '../enums/competition-type.enum';

export enum ActiveCompetitionStatus {
  UPCOMING = 'UPCOMING',
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  FINISHED = 'FINISHED',
}

export interface ActiveCompetition {
  /**
   * Stable internal competition identifier.
   *
   * For ESPN this is normally the configured competition ID.
   */
  competitionId: string;

  /**
   * Display name.
   */
  name: string;

  /**
   * Competition category.
   */
  type: CompetitionType;

  /**
   * Geographic region.
   */
  region: CompetitionRegion;

  /**
   * Application priority.
   */
  priority: CompetitionPriority;

  /**
   * Canonical ESPN league slug.
   *
   * Examples:
   * eng.1
   * esp.1
   * uefa.champions
   */
  espnLeagueSlug: string;

  /**
   * Optional Football-Data competition code.
   */
  footballDataCode?: string;

  /**
   * Optional The Odds API sport key.
   */
  oddsApiSportKey?: string;

  /**
   * Current season year.
   */
  season?: number;

  /**
   * Known season start date.
   */
  seasonStartDate?: Date;

  /**
   * Known season end date.
   */
  seasonEndDate?: Date;

  /**
   * Latest known fixture.
   */
  lastFixtureDate?: Date;

  /**
   * Next known fixture.
   */
  nextFixtureDate?: Date;

  /**
   * Current derived competition status.
   */
  status: ActiveCompetitionStatus;

  /**
   * Complete latest ESPN league/discovery payload.
   */
  espnPayload?: Record<string, unknown>;

  /**
   * Last time this competition record was updated.
   */
  lastUpdatedAt?: Date;
}

