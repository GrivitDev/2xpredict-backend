export enum PredictionAccessPlan {
  ANONYMOUS = 'anonymous',
  FREE = 'free',
  REGULAR = 'regular',
  VIP = 'vip',
  PREMIUM = 'premium',
}

export type PaidPredictionPlan = Exclude<
  PredictionAccessPlan,
  PredictionAccessPlan.ANONYMOUS | PredictionAccessPlan.FREE
>;
