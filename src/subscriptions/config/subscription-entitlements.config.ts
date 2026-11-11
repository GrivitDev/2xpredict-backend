import { PlanType } from '../schemas/subscription.schema';

export type SubscriptionEntitlementPlan = 'anonymous' | PlanType;

/**
 * Subscription-level entitlements that are independent of Prediction Access.
 * Advertising is removed only for VIP and Premium subscribers.
 */
export function getSubscriptionEntitlements(
  plan: SubscriptionEntitlementPlan,
): {
  plan: SubscriptionEntitlementPlan;
  advertising: {
    adsEnabled: boolean;
    adFree: boolean;
    adRemovalIncluded: boolean;
  };
} {
  const adFree = plan === 'vip' || plan === 'premium';

  return {
    plan,
    advertising: {
      adsEnabled: !adFree,
      adFree,
      adRemovalIncluded: adFree,
    },
  };
}
