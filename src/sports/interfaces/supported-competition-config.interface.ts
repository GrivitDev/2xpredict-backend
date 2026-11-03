import { CollectionFrequency } from '../enums/collection-frequency.enum';
import { CompetitionPriority } from '../enums/competition-priority.enum';
import { CompetitionRegion } from '../enums/competition-region.enum';
import { CompetitionType } from '../enums/competition-type.enum';

export interface SupportedCompetitionConfig {
  /**
   * Stable ESPN league slug.
   */
  id: string;

  /**
   * Human-readable competition name.
   */
  name: string;

  type: CompetitionType;

  region: CompetitionRegion;

  /**
   * Priority assigned when this competition is part
   * of our curated priority list.
   */
  priority: CompetitionPriority;

  enabled: boolean;

  predictionEnabled: boolean;

  oddsEnabled: boolean;

  collectionFrequency: CollectionFrequency;

  providers: CompetitionProviderMapping;

  seasonal?: boolean;

  gender?: 'MEN' | 'WOMEN';

  notes?: string;
}

export interface CompetitionProviderMapping {
  /**
   * Canonical ESPN competition identifier.
   */
  espnLeagueSlug: string;

  /**
   * Football-Data.org coverage, where available.
   */
  footballDataCode?: string;

  /**
   * The Odds API sport key, where available.
   */
  oddsApiSportKey?: string;
}

