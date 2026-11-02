export const BET_LAB_CONFIG = {
  virtualPoints: {
    registrationBonus: 10_000,
    monthlyAllowanceByPlan: {
      free: 1_000,
      regular: 3_000,
      vip: 5_000,
      premium: 10_000,
    },
    allowancePeriodDays: 30,
    /** Integer virtual points; no monetary value. */
    minimumStake: 1,
    maximumStake: Number.MAX_SAFE_INTEGER,
    maximumPotentialReturn: Number.MAX_SAFE_INTEGER,
  },
  tickets: {
    maximumAccumulatorLegs: 20,
    minimumAccumulatorLegs: 2,
    settledTicketRetentionDays: 7,
    /** Odds products above this guard are rejected to avoid numeric overflow. */
    maximumCombinedOdds: 1_000_000,
  },
  odds: {
    /** Derive fair prices for Double Chance and Draw No Bet from a complete 1X2 quote. */
    allowDerivedFairOddsForDoubleChanceAndDrawNoBet: true,
    /** Quotes older than this are displayed as stale and cannot be used for new tickets. */
    maximumAgeHours: 72,
    minimumDecimalOdds: 1.01,
    maximumDecimalOdds: 100_000,
    decimalPlaces: 4,
  },
  monitor: {
    recentEventsLimit: 50,
    defaultHistoryPageSize: 20,
    maximumHistoryPageSize: 100,
    eventRetentionDays: 90,
  },
} as const;

export type BetLabPlan =
  keyof typeof BET_LAB_CONFIG.virtualPoints.monthlyAllowanceByPlan;
