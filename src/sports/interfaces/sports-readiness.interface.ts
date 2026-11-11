/** Read-only coverage contract used by Odds and other Sports consumers. */
export type SportsReadinessState =
  | 'READY'
  | 'INSUFFICIENT'
  | 'MISSING'
  | 'UNSUPPORTED';

export interface SportsReadinessMeasure {
  state: SportsReadinessState;
  ready: boolean;
  sampleSize: number;
  minimumSampleSize: number;
  quality: number | null;
  minimumQuality: number;
  coverageRate?: number | null;
  minimumCoverageRate?: number;
  reason?: string;
}

export interface SportsStatisticReadiness extends SportsReadinessMeasure {
  key: string;
  homeSampleSize: number;
  awaySampleSize: number;
  homeAverage: number | null;
  awayAverage: number | null;
}

export interface SportsEventReadiness extends SportsReadinessMeasure {
  eventMatches: number | null;
}

export interface SportsFixtureReadiness {
  fixtureId: string;
  competitionId: string;
  seasonId?: string;
  checkedAt: Date;
  fixtureEligible: boolean;
  fixtureIneligibleReason?: string;

  /** Full-time score model used by result, goals, BTTS and handicap markets. */
  scoreMatrix: SportsReadinessMeasure & {
    homeSampleSize: number;
    awaySampleSize: number;
    hasHomeGoalInputs: boolean;
    hasAwayGoalInputs: boolean;
    venueProjectionAvailable: boolean;
    competitionProjectionAvailable: boolean;
    headToHeadSampleSize: number;
    recentFormSampleSize: number;
  };

  /** Period markets require observed first-half splits on both teams. */
  periodMatrix: SportsReadinessMeasure & {
    homePeriodObservations: number;
    awayPeriodObservations: number;
    observedPeriodSplit: boolean;
  };

  /** First/last scorer markets can use the score model without timeline enrichment. */
  goalOrderMarkets: SportsReadinessMeasure & {
    firstGoalEmpiricalAdjustmentReady: boolean;
    lastGoalEmpiricalAdjustmentReady: boolean;
    homeTimelineSamples: number;
    awayTimelineSamples: number;
  };

  /** Each statistic is assessed independently; one missing statistic never blocks another. */
  teamStatistics: Record<string, SportsStatisticReadiness>;

  timeline: SportsReadinessMeasure & {
    coveredFixtures: number;
    completedFixtures: number;
  };

  eventMarkets: {
    redCard: SportsEventReadiness;
    penaltyAwarded: SportsEventReadiness;
    ownGoal: SportsEventReadiness;
  };

  /** Per-player pricing remains disabled in the current Odds pricing engine. */
  playerMarkets: SportsReadinessMeasure & {
    pricingSupported: false;
  };

  sourceComputedAt: {
    homeScoring: Date | null;
    awayScoring: Date | null;
    homeAway: Date | null;
    awayAway: Date | null;
    competitionScoring: Date | null;
    homeStatistics: Date | null;
    awayStatistics: Date | null;
    headToHead: Date | null;
  };
}
