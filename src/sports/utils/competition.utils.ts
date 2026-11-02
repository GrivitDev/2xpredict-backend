import { CollectionFrequency } from '../enums/collection-frequency.enum';
import { CompetitionPriority } from '../enums/competition-priority.enum';
import { CompetitionRegion } from '../enums/competition-region.enum';
import { CompetitionType } from '../enums/competition-type.enum';
import { SupportedCompetitionConfig } from '../interfaces/supported-competition-config.interface';

// ============================================================
// BASIC COLLECTIONS
// ============================================================

export function getAllCompetitions(
  competitions: SupportedCompetitionConfig[],
): SupportedCompetitionConfig[] {
  return [...competitions];
}

export function getEnabledCompetitions(
  competitions: SupportedCompetitionConfig[],
): SupportedCompetitionConfig[] {
  return competitions.filter((competition) => competition.enabled);
}

export function getPredictionCompetitions(
  competitions: SupportedCompetitionConfig[],
): SupportedCompetitionConfig[] {
  return competitions.filter(
    (competition) => competition.enabled && competition.predictionEnabled,
  );
}

export function getOddsCompetitions(
  competitions: SupportedCompetitionConfig[],
): SupportedCompetitionConfig[] {
  return competitions.filter(
    (competition) => competition.enabled && competition.oddsEnabled,
  );
}

// ============================================================
// LOOKUPS
// ============================================================

export function getCompetitionById(
  competitions: SupportedCompetitionConfig[],
  competitionId: string,
): SupportedCompetitionConfig | undefined {
  const id = competitionId.trim().toLowerCase();

  return competitions.find((competition) => competition.id === id);
}

export function getCompetitionsByType(
  competitions: SupportedCompetitionConfig[],
  type: CompetitionType,
): SupportedCompetitionConfig[] {
  return competitions.filter((competition) => competition.type === type);
}

export function getCompetitionsByRegion(
  competitions: SupportedCompetitionConfig[],
  region: CompetitionRegion,
): SupportedCompetitionConfig[] {
  return competitions.filter((competition) => competition.region === region);
}

export function getCompetitionsByPriority(
  competitions: SupportedCompetitionConfig[],
  priority: CompetitionPriority,
): SupportedCompetitionConfig[] {
  return competitions.filter(
    (competition) => competition.priority === priority,
  );
}

export function getCompetitionsByFrequency(
  competitions: SupportedCompetitionConfig[],
  frequency: CollectionFrequency,
): SupportedCompetitionConfig[] {
  return competitions.filter(
    (competition) => competition.collectionFrequency === frequency,
  );
}

// ============================================================
// COLLECTION GROUPS
// ============================================================

export function getDailyCompetitions(
  competitions: SupportedCompetitionConfig[],
): SupportedCompetitionConfig[] {
  return getCompetitionsByFrequency(competitions, CollectionFrequency.DAILY);
}

export function getMonthlyCompetitions(
  competitions: SupportedCompetitionConfig[],
): SupportedCompetitionConfig[] {
  return getCompetitionsByFrequency(competitions, CollectionFrequency.MONTHLY);
}

export function getSupportedLeagues(
  competitions: SupportedCompetitionConfig[],
): SupportedCompetitionConfig[] {
  return getCompetitionsByType(competitions, CompetitionType.LEAGUE);
}

export function getClubCompetitions(
  competitions: SupportedCompetitionConfig[],
): SupportedCompetitionConfig[] {
  return getCompetitionsByType(competitions, CompetitionType.CLUB_COMPETITION);
}

export function getInternationalCompetitions(
  competitions: SupportedCompetitionConfig[],
): SupportedCompetitionConfig[] {
  return getCompetitionsByType(competitions, CompetitionType.INTERNATIONAL);
}

// ============================================================
// PROVIDER MAPPINGS
// ============================================================

export function hasEspnMapping(
  competition: SupportedCompetitionConfig,
): boolean {
  return Boolean(competition.providers.espnLeagueSlug);
}

export function hasFootballDataMapping(
  competition: SupportedCompetitionConfig,
): boolean {
  return Boolean(competition.providers.footballDataCode);
}

export function hasOddsApiMapping(
  competition: SupportedCompetitionConfig,
): boolean {
  return Boolean(competition.providers.oddsApiSportKey);
}

// ============================================================
// PRIORITY
// ============================================================

export function getPriorityWeight(priority: CompetitionPriority): number {
  switch (priority) {
    case CompetitionPriority.ELITE:
      return 1;

    case CompetitionPriority.HIGH:
      return 2;

    case CompetitionPriority.REGIONAL:
      return 3;

    case CompetitionPriority.SELECTIVE:
      return 4;

    default:
      return 99;
  }
}

export function sortByPriority(
  competitions: SupportedCompetitionConfig[],
): SupportedCompetitionConfig[] {
  return [...competitions].sort(
    (a, b) => getPriorityWeight(a.priority) - getPriorityWeight(b.priority),
  );
}

export function getHighValueCompetitions(
  competitions: SupportedCompetitionConfig[],
): SupportedCompetitionConfig[] {
  return sortByPriority(
    competitions.filter(
      (competition) =>
        competition.enabled &&
        (competition.priority === CompetitionPriority.ELITE ||
          competition.priority === CompetitionPriority.HIGH),
    ),
  );
}

export function getActiveMensCompetitions(
  competitions: SupportedCompetitionConfig[],
): SupportedCompetitionConfig[] {
  return competitions.filter(
    (competition) => competition.enabled && competition.gender === 'MEN',
  );
}

// ============================================================
// PRIORITY MATCHING
// ============================================================

export function matchPriorityCompetitions(
  activeCompetitions: SupportedCompetitionConfig[],
  priorityCompetitions: SupportedCompetitionConfig[],
): SupportedCompetitionConfig[] {
  const priorityMap = new Map(
    priorityCompetitions.map((competition) => [competition.id, competition]),
  );

  return sortByPriority(
    activeCompetitions.filter((competition) => priorityMap.has(competition.id)),
  );
}

// ============================================================
// VALIDATION / COUNTS
// ============================================================

export function isSupportedCompetition(
  competitions: SupportedCompetitionConfig[],
  competitionId: string,
): boolean {
  return Boolean(getCompetitionById(competitions, competitionId));
}

export function getCompetitionCounts(
  competitions: SupportedCompetitionConfig[],
) {
  return {
    total: competitions.length,

    enabled: getEnabledCompetitions(competitions).length,

    prediction: getPredictionCompetitions(competitions).length,

    odds: getOddsCompetitions(competitions).length,

    monthly: getMonthlyCompetitions(competitions).length,

    daily: getDailyCompetitions(competitions).length,

    leagues: getSupportedLeagues(competitions).length,

    clubCompetitions: getClubCompetitions(competitions).length,

    internationalCompetitions:
      getInternationalCompetitions(competitions).length,

    espn: competitions.filter(hasEspnMapping).length,

    footballData: competitions.filter(hasFootballDataMapping).length,

    oddsApi: competitions.filter(hasOddsApiMapping).length,
  };
}

