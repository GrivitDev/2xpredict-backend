import { CollectionFrequency } from '../enums/collection-frequency.enum';
import { CompetitionPriority } from '../enums/competition-priority.enum';
import { CompetitionRegion } from '../enums/competition-region.enum';
import { CompetitionType } from '../enums/competition-type.enum';
import { CompetitionProviderMapping } from './supported-competition-config.interface';

export interface SportsLeague {
  /**
   * ESPN league slug.
   */
  id: string;

  /**
   * ESPN competition name.
   */
  name: string;

  type: CompetitionType;

  region: CompetitionRegion;

  priority: CompetitionPriority;

  enabled: boolean;

  predictionEnabled: boolean;

  oddsEnabled: boolean;

  collectionFrequency: CollectionFrequency;

  providers: CompetitionProviderMapping;
}

/**
 * Keep the shared match types defined in one place. Re-exporting them here
 * preserves existing imports from league.interface.ts without duplicating
 * their definitions.
 */
export type {
  SportsMatch,
  SportsMatchScore,
  SportsMatchTeam,
} from './match.interface';
