import { PredictionAccessPlan } from '../enums/prediction-access-plan.enum';
import { CompetitionPriority } from '../../sports/enums/competition-priority.enum';

export interface AccessRequestUser {
  _id?: unknown;
  id?: unknown;
  userId?: unknown;
  sub?: unknown;
  [key: string]: unknown;
}

export interface PredictionAccessDecision {
  allowed: boolean;
  settled: boolean;
  plan: PredictionAccessPlan;
  priority: CompetitionPriority | 'UNKNOWN';
  state:
    | 'settled_public'
    | 'subscription'
    | 'selective_league_access'
    | 'upgrade_required'
    | 'not_published';
  message: string | null;
}

export interface PredictionReadFilters {
  eventId?: string;
  leagueId?: string;
  marketKey?: string;
  selectionKey?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
  includePast?: boolean;
  minimumProbability?: number;
  minimumConfidence?: number;
  status?: string;
}
