import { PredictionAccessService } from './prediction-access.service';
import { PredictionAccessPlan } from './enums/prediction-access-plan.enum';
import {
  ENABLED_PREDICTION_MARKET_KEYS,
  PREDICTION_ACCESS_CONFIG,
} from './config/prediction-access.config';

const service = Object.create(
  PredictionAccessService.prototype,
) as PredictionAccessService;
const privateService = service as any;

const plans = [
  PredictionAccessPlan.ANONYMOUS,
  PredictionAccessPlan.FREE,
  PredictionAccessPlan.REGULAR,
  PredictionAccessPlan.VIP,
  PredictionAccessPlan.PREMIUM,
];

describe('PredictionAccessService commercial access policy', () => {
  it('filters market selections using the precomputed approved selection references', () => {
    const market = {
      _id: 'market-1',
      eventId: 'fixture-1',
      leagueId: 'league-1',
      selections: [
        {
          key: 'HOME',
          status: 'CALCULATED',
          probability: 0.62,
          confidence: 78,
        },
        {
          key: 'DRAW',
          status: 'CALCULATED',
          probability: 0.24,
          confidence: 72,
        },
        {
          key: 'AWAY',
          status: 'CALCULATED',
          probability: 0.14,
          confidence: 70,
          actualOutcome: 'WON',
        },
      ],
    };
    const approved = new Set(['market-1::HOME']);

    const result = privateService.filterActiveMarket(
      market,
      { eventId: 'fixture-1', leagueId: 'league-1' },
      PredictionAccessPlan.PREMIUM,
      {},
      approved,
    );

    expect(result?.selections.map((selection: any) => selection.key)).toEqual([
      'HOME',
    ]);
    expect(result?.access.mode).toBe('DAILY_LEAGUE_AND_MARKET_ENTITLEMENTS');
  });

  it('configures Pick Center daily league percentages and market caps', () => {
    expect(
      plans.map((plan) => PREDICTION_ACCESS_CONFIG.leagueVisibility[plan]),
    ).toEqual([20, 30, 60, 95, 100]);
    expect(
      plans.map(
        (plan) => PREDICTION_ACCESS_CONFIG.marketVisibility[plan].limit,
      ),
    ).toEqual([3, 7, 16, 48, null]);
  });

  it('returns each fixture’s highest-ranked distinct Pick Center market groups up to the plan limit', () => {
    const selections = ENABLED_PREDICTION_MARKET_KEYS.map(
      (marketKey, index) => ({
        marketKey,
        marketPredictionId: `prediction-${index}`,
        selectionKey: `selection-${index}`,
        rank: index + 1,
      }),
    ).reverse();

    for (const plan of plans) {
      const result = privateService.filterPickCenter(
        { eventId: 'fixture-1', selectedMarkets: selections },
        plan,
      );
      const limit = PREDICTION_ACCESS_CONFIG.marketVisibility[plan].limit;
      const expected =
        limit === null ? selections.length : Math.min(limit, selections.length);

      expect(result.selectedMarkets).toHaveLength(expected);
      expect(result.visibleMarketCount).toBe(expected);
      expect(result.lockedMarketCount).toBe(selections.length - expected);
      expect(result.selectedMarkets[0].rank).toBe(1);
    }
  });

  it('configures Curated Prediction daily league percentages', () => {
    expect(
      plans.map(
        (plan) => PREDICTION_ACCESS_CONFIG.curatedLeagueVisibility[plan],
      ),
    ).toEqual([2, 8, 40, 75, 100]);
  });

  it('moves locked Curated league access to the next subscription tier', () => {
    expect(
      privateService.nextRequiredCuratedPlan(PredictionAccessPlan.ANONYMOUS),
    ).toBe(PredictionAccessPlan.FREE);
    expect(
      privateService.nextRequiredCuratedPlan(PredictionAccessPlan.FREE),
    ).toBe(PredictionAccessPlan.REGULAR);
    expect(
      privateService.nextRequiredCuratedPlan(PredictionAccessPlan.REGULAR),
    ).toBe(PredictionAccessPlan.VIP);
    expect(
      privateService.nextRequiredCuratedPlan(PredictionAccessPlan.VIP),
    ).toBe(PredictionAccessPlan.PREMIUM);
  });

  it('uses the requested Pick Center and Curated daily league allocations', () => {
    const entries = Array.from({ length: 20 }, (_, index) => ({
      leagueId: `league-${index + 1}`,
      date: '2026-11-20T12:00:00.000Z',
    }));
    const expectedPickCenter = [4, 6, 12, 19, 20];
    const expectedCurated = [1, 2, 8, 15, 20];

    plans.forEach((plan, index) => {
      const pickCenter = privateService.buildDailyLeagueAccessAllocation(
        entries,
        plan,
        'PICK_CENTER',
      );
      const curated = privateService.buildDailyLeagueAccessAllocation(
        entries,
        plan,
        'CURATED',
      );
      expect(pickCenter.accessibleByDate.get('2026-11-20')?.size).toBe(
        expectedPickCenter[index],
      );
      expect(curated.accessibleByDate.get('2026-11-20')?.size).toBe(
        expectedCurated[index],
      );
    });
  });

  it('grants ODDS 10 to VIP and Premium, but ODDS 25 and ODDS 50 only to Premium', () => {
    const canAccess = (
      plan: PredictionAccessPlan,
      productType: string,
      odds: number,
    ) =>
      privateService.canAccessSlip(plan, {
        status: 'PUBLISHED',
        productType,
        combinedOdds: odds,
      });

    expect(canAccess(PredictionAccessPlan.VIP, 'ODDS_10', 9.5)).toBe(true);
    expect(canAccess(PredictionAccessPlan.PREMIUM, 'ODDS_10', 9.5)).toBe(true);
    expect(canAccess(PredictionAccessPlan.REGULAR, 'ODDS_10', 9.5)).toBe(false);
    expect(canAccess(PredictionAccessPlan.VIP, 'ODDS_25', 24)).toBe(false);
    expect(canAccess(PredictionAccessPlan.PREMIUM, 'ODDS_25', 24)).toBe(true);
    expect(canAccess(PredictionAccessPlan.PREMIUM, 'ODDS_50', 49)).toBe(true);
    expect(canAccess(PredictionAccessPlan.VIP, 'ODDS_50', 49)).toBe(false);
  });

  it('grants SURE 2 and SURE 7 from Regular upward, and SURE 5 only to Premium', () => {
    const canAccess = (
      plan: PredictionAccessPlan,
      product: string,
      odds: number,
    ) =>
      privateService.canAccessSlip(plan, {
        status: 'PUBLISHED',
        productType: 'SURE_ODDS',
        sureOdds: true,
        sureOddsProduct: product,
        combinedOdds: odds,
      });

    for (const plan of [
      PredictionAccessPlan.REGULAR,
      PredictionAccessPlan.VIP,
      PredictionAccessPlan.PREMIUM,
    ]) {
      expect(canAccess(plan, 'SURE_2', 1.9)).toBe(true);
      expect(canAccess(plan, 'SURE_7', 6.5)).toBe(true);
    }
    expect(canAccess(PredictionAccessPlan.REGULAR, 'SURE_5', 4.75)).toBe(false);
    expect(canAccess(PredictionAccessPlan.VIP, 'SURE_5', 4.75)).toBe(false);
    expect(canAccess(PredictionAccessPlan.PREMIUM, 'SURE_5', 4.75)).toBe(true);
  });

  it('publishes the same Slip Center and Sure Odds entitlements as enforcement', () => {
    const policy = privateService.getPolicy().rules;
    expect(policy.vip.slipProducts).toEqual(['ODDS_10']);
    expect(policy.premium.slipProducts).toEqual([
      'ODDS_10',
      'ODDS_25',
      'ODDS_50',
    ]);
    expect(policy.regular.sureOdds).toEqual(['SURE_2', 'SURE_7']);
    expect(policy.vip.sureOdds).toEqual(['SURE_2', 'SURE_7']);
    expect(policy.premium.sureOdds).toEqual(['SURE_2', 'SURE_5', 'SURE_7']);
  });
});

