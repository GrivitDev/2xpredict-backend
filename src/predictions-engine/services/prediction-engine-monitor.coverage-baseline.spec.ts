import { PREDICTION_ENGINE_CONFIG } from '../config/prediction-engine.config';
import { PredictionEngineMonitorService } from './prediction-engine-monitor.service';
import { ODDS_CONFIG } from '../../odds/config/odds.config';

const query = (value: unknown) => ({
  select: jest.fn().mockReturnThis(),
  sort: jest.fn().mockReturnThis(),
  skip: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  lean: jest.fn().mockReturnThis(),
  exec: jest.fn().mockResolvedValue(value),
});

describe('PredictionEngineMonitorService baseline coverage audit', () => {
  it('counts complete provisional 1X2 prices separately from prediction-ready Odds', async () => {
    const service = Object.create(PredictionEngineMonitorService.prototype) as any;
    const now = new Date();
    const eventId = 'fixture-baseline';
    const fingerprint = 'source-fingerprint-1';
    const kickoffAt = new Date(now.getTime() + 24 * 60 * 60_000);
    const fixture = {
      id: eventId,
      competitionId: 'league-one',
      kickoffAt,
      status: { state: 'SCHEDULED', isFinal: false },
      competitors: [
        { homeAway: 'HOME', teamId: 'home-1' },
        { homeAway: 'AWAY', teamId: 'away-1' },
      ],
    };
    const marketDocument = {
      _id: 'market-result-document',
      eventId,
      marketKey: 'MATCH_RESULT',
      modelVersion: PREDICTION_ENGINE_CONFIG.modelVersion,
      status: 'CALCULATED',
      fixtureSourceRevision: 7,
      sourceRevisionFingerprint: fingerprint,
      generatedAt: now,
      selections: [
        {
          key: 'HOME_WIN', status: 'CALCULATED', probability: 0.54,
          confidence: 40, evidenceConfidence: 8, evidenceLevel: 'PRIOR_ONLY',
          dataQuality: 0.12, isFinalSelection: true,
        },
        {
          key: 'DRAW', status: 'CALCULATED', probability: 0.27,
          confidence: 40, evidenceConfidence: 8, evidenceLevel: 'PRIOR_ONLY',
          dataQuality: 0.12, isFinalSelection: false,
        },
        {
          key: 'AWAY_WIN', status: 'CALCULATED', probability: 0.19,
          confidence: 40, evidenceConfidence: 8, evidenceLevel: 'PRIOR_ONLY',
          dataQuality: 0.12, isFinalSelection: false,
        },
      ],
    };
    const quote = (selectionKey: string, decimalOdds: number) => ({
      eventId,
      marketId: 'MATCH_RESULT',
      selectionKey,
      decimalOdds,
      priceType: 'ESTIMATED',
      predictionReady: false,
      pricingStatus: 'CURRENT',
      isFresh: true,
      bookmaker: 'Grivit',
      pricingSource: 'GRIVIT_MODEL',
      oddsBasis: 'PRIOR_ONLY',
      calculationVersion: ODDS_CONFIG.modelVersion,
      fixtureSourceRevision: 7,
      sourceDataHash: 'baseline-source-hash',
      oddsCalculationMethod: 'BASELINE_POISSON_GLOBAL_PRIOR',
    });

    service.sportsRead = {
      getFixtures: jest.fn().mockResolvedValue({ items: [fixture] }),
      countFixtures: jest.fn().mockResolvedValue(1),
    };
    service.queueModel = {
      find: jest.fn().mockReturnValue(query([{
        eventId,
        status: 'COMPLETED',
        modelVersion: PREDICTION_ENGINE_CONFIG.modelVersion,
        sourceRevisionFingerprint: fingerprint,
        attempts: 1,
        updatedAt: now,
      }])),
    };
    service.marketModel = { find: jest.fn().mockReturnValue(query([marketDocument])) };
    service.oddsRead = {
      getPricesForFixtures: jest.fn().mockResolvedValue([
        quote('HOME_WIN', 1.8),
        quote('DRAW', 3.5),
        quote('AWAY_WIN', 4.6),
      ]),
    };
    service.sportsRevisions = {
      getCurrentRevisions: jest.fn().mockResolvedValue(new Map([[eventId, 7]])),
    };

    const result = await service.getFixtureCoverageInventory({
      from: new Date(now.getTime() - 60_000).toISOString(),
      to: new Date(now.getTime() + 48 * 60 * 60_000).toISOString(),
      pageSize: 50,
    });

    expect(result.totals).toMatchObject({
      sportsFixturesScanned: 1,
      eligibleFixtures: 1,
      predictionRequiredFixtures: 1,
      fixturesWithBaselinePrediction: 1,
      fixturesWithCurrentPrediction: 1,
      oddsRequiredFixtures: 1,
      fixturesWithBaselineGrivitOdds: 1,
      fixturesWithCurrentGrivitOdds: 1,
      fixturesWithProvisionalPredictions: 1,
      fixturesWithProvisionalGrivitOdds: 1,
      fullyCoveredFixtures: 1,
    });
    expect(result.fixtures[0].prediction).toMatchObject({
      covered: true,
      provisional: true,
      selectionCount: 3,
    });
    expect(result.fixtures[0].odds).toMatchObject({
      covered: true,
      provisional: true,
      requiredSelectionCount: 3,
      availableSelectionCount: 3,
    });
  });
});
