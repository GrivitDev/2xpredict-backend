import { ODDS_CONFIG } from '../config/odds.config';
import { OddsService } from './odds.service';

describe('OddsService baseline Match Result readiness', () => {
  const makeRow = (selectionKey: string) => ({
    eventId: 'fixture-1',
    marketId: 'MATCH_RESULT',
    selectionKey,
    decimalOdds: 2.1,
    predictionReady: true,
    calculationVersion: ODDS_CONFIG.modelVersion,
    priceType: 'ESTIMATED',
    bookmaker: 'Grivit',
    pricingSource: 'GRIVIT_MODEL',
    dataQuality: 0.05,
    sampleSize: 0,
    sourceDataHash: 'source-hash',
    fixtureSourceRevision: 4,
    oddsBasis: 'PRIOR_ONLY',
    fairOdds: 2.2,
    fairProbability: 0.4545,
    updatedAt: new Date('2026-11-23T10:00:00.000Z'),
  });

  const makeService = (rows: Record<string, unknown>[]) => {
    const service = Object.create(OddsService.prototype) as any;
    service.oddsModel = {
      find: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(rows),
      }),
    };
    service.sportsRevisions = {
      getCurrentRevisions: jest.fn().mockResolvedValue(new Map([['fixture-1', 4]])),
    };
    jest.spyOn(service, 'activeModelFilter').mockReturnValue({});
    return service as OddsService;
  };

  it('marks a complete prior-only 1X2 set ready without the former sample and quality floors', async () => {
    const service = makeService([
      makeRow('HOME_WIN'),
      makeRow('DRAW'),
      makeRow('AWAY_WIN'),
    ]);

    const result = await service.getPredictionReadinessForEvents(['fixture-1']);
    const readiness = result.get('fixture-1');

    expect(readiness.ready).toBe(true);
    expect(readiness.readySelections).toBe(3);
    expect(readiness.priorOnlySelections).toBe(3);
  });

  it('does not call an incomplete 1X2 set fully ready', async () => {
    const service = makeService([
      makeRow('HOME_WIN'),
      makeRow('DRAW'),
    ]);

    const result = await service.getPredictionReadinessForEvents(['fixture-1']);

    expect(result.get('fixture-1').ready).toBe(false);
    expect(result.get('fixture-1').reason).toContain('2/3');
  });
});
