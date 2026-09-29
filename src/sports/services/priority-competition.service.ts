// backend/src/sports/services/priority-competition.service.ts

import { Injectable } from '@nestjs/common';

import {
  PRIORITY_COMPETITIONS,
  getPriorityCompetition,
} from '../config/priority-competitions.config';

import { CollectionFrequency } from '../enums/collection-frequency.enum';
import { CompetitionPriority } from '../enums/competition-priority.enum';
import { CompetitionRegion } from '../enums/competition-region.enum';
import { CompetitionType } from '../enums/competition-type.enum';

import { SupportedCompetitionConfig } from '../interfaces/supported-competition-config.interface';

import {
  getActiveMensCompetitions,
  getClubCompetitions,
  getCompetitionCounts,
  getCompetitionsByFrequency,
  getCompetitionsByPriority,
  getCompetitionsByRegion,
  getCompetitionsByType,
  getDailyCompetitions,
  getEnabledCompetitions,
  getHighValueCompetitions,
  getInternationalCompetitions,
  getMonthlyCompetitions,
  getOddsCompetitions,
  getPredictionCompetitions,
  getSupportedLeagues,
  hasEspnMapping,
  hasFootballDataMapping,
  hasOddsApiMapping,
  sortByPriority,
} from '../utils/competition.utils';

@Injectable()
export class PriorityCompetitionService {
  private readonly competitions: SupportedCompetitionConfig[] =
    PRIORITY_COMPETITIONS;

  // ============================================================
  // ALL CONFIGURATION
  // ============================================================

  getAll(): SupportedCompetitionConfig[] {
    return [...this.competitions];
  }

  getById(competitionId: string): SupportedCompetitionConfig | undefined {
    const normalizedId = this.normalizeId(competitionId);

    if (!normalizedId) {
      return undefined;
    }

    return getPriorityCompetition(normalizedId);
  }

  // ============================================================
  // FILTERS
  // ============================================================

  getEnabled(): SupportedCompetitionConfig[] {
    return getEnabledCompetitions(this.competitions);
  }

  getPredictionEnabled(): SupportedCompetitionConfig[] {
    return getPredictionCompetitions(this.competitions);
  }

  getOddsEnabled(): SupportedCompetitionConfig[] {
    return getOddsCompetitions(this.competitions);
  }

  getByType(type: CompetitionType): SupportedCompetitionConfig[] {
    return getCompetitionsByType(this.competitions, type);
  }

  getByRegion(region: CompetitionRegion): SupportedCompetitionConfig[] {
    return getCompetitionsByRegion(this.competitions, region);
  }

  getByPriority(priority: CompetitionPriority): SupportedCompetitionConfig[] {
    return getCompetitionsByPriority(this.competitions, priority);
  }

  getByFrequency(frequency: CollectionFrequency): SupportedCompetitionConfig[] {
    return getCompetitionsByFrequency(this.competitions, frequency);
  }

  // ============================================================
  // COLLECTION GROUPS
  // ============================================================

  getDaily(): SupportedCompetitionConfig[] {
    return getDailyCompetitions(this.competitions);
  }

  getMonthly(): SupportedCompetitionConfig[] {
    return getMonthlyCompetitions(this.competitions);
  }

  getLeagues(): SupportedCompetitionConfig[] {
    return getSupportedLeagues(this.competitions);
  }

  getClubCompetitions(): SupportedCompetitionConfig[] {
    return getClubCompetitions(this.competitions);
  }

  getInternationalCompetitions(): SupportedCompetitionConfig[] {
    return getInternationalCompetitions(this.competitions);
  }

  getHighValue(): SupportedCompetitionConfig[] {
    return getHighValueCompetitions(this.competitions);
  }

  getActiveMens(): SupportedCompetitionConfig[] {
    return getActiveMensCompetitions(this.competitions);
  }

  // ============================================================
  // PROVIDER MAPPINGS
  // ============================================================

  getWithEspn(): SupportedCompetitionConfig[] {
    return this.competitions.filter(hasEspnMapping);
  }

  getWithFootballData(): SupportedCompetitionConfig[] {
    return this.competitions.filter(hasFootballDataMapping);
  }

  getWithOddsApi(): SupportedCompetitionConfig[] {
    return this.competitions.filter(hasOddsApiMapping);
  }

  // ============================================================
  // SORTING / COUNTS
  // ============================================================

  getSortedByPriority(): SupportedCompetitionConfig[] {
    return sortByPriority(this.competitions);
  }

  getConfigCount() {
    return getCompetitionCounts(this.competitions);
  }

  // ============================================================
  // LOOKUPS
  // ============================================================

  isPriorityCompetition(competitionId: string): boolean {
    return Boolean(this.getById(competitionId));
  }

  // ============================================================
  // HELPERS
  // ============================================================

  private normalizeId(value: string | undefined): string {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
  }
}
