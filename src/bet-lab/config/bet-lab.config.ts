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
    minimumAccumulatorLegs: 2,
    settledTicketRetentionDays: 7,
  },
  odds: {
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


