/** Field-level visibility is evaluated on the server for every delivery and nested selection. */
export interface AdContentVisibility {
  showProbability?: boolean;
  showConfidence?: boolean;
  showMarketName?: boolean;
  showMarketSelections?: boolean;
  showFairOdds?: boolean;
  showBookmakerOdds?: boolean;
  showDecimalOdds?: boolean;
  showCombinedOdds?: boolean;
  showCombinedProbability?: boolean;
  showLegCount?: boolean;
  showTeams?: boolean;
  showLeague?: boolean;
  showFixtureDate?: boolean;
  showProductName?: boolean;
  showRewardValue?: boolean;
  showPromoCode?: boolean;
  showDescription?: boolean;
  showSportyBetCode?: boolean;
  showSelectionCount?: boolean;
  showSubscriptionPricing?: boolean;
  showWelcomePoints?: boolean;
}

export type AdAudienceKey = 'GUEST' | 'FREE' | 'REGULAR' | 'VIP' | 'PREMIUM';
export type AdAudienceVisibility = Partial<
  Record<AdAudienceKey, AdContentVisibility>
>;

export interface AdTargeting {
  allowedPlans?: AdAudienceKey[];
  excludedPlans?: AdAudienceKey[];
  requireAuthenticated?: boolean;
  guestsOnly?: boolean;
}
