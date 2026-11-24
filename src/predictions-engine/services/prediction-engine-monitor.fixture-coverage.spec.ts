import { PredictionEngineMonitorService } from './prediction-engine-monitor.service';
import { PREDICTION_ENGINE_CONFIG } from '../config/prediction-engine.config';
import { ODDS_CONFIG } from '../../odds/config/odds.config';

const query = (value: unknown) => ({
  select: jest.fn().mockReturnThis(),
  sort: jest.fn().mockReturnThis(),
  lean: jest.fn().mockReturnThis(),
  exec: jest.fn().mockResolvedValue(value),
});

const predictionDocument = (eventId: string, status = 'CALCULATED', revision = 2) => ({
  eventId,
  marketKey: 'MATCH_RESULT',
  modelVersion: PREDICTION_ENGINE_CONFIG.modelVersion,
  status,
  fixtureSourceRevision: revision,
  sourceRevisionFingerprint: `sports-fingerprint-v${revision}`,
  generatedAt: new Date(),
  selections: [
    {
      key: 'HOME_WIN',
      status: 'CALCULATED',
      probability: 0.48,
      confidence: 40,
      evidenceConfidence: 8,
      evidenceLevel: 'PRIOR_ONLY',
      dataQuality: 0.12,
      isFinalSelection: true,
    },
    {
      key: 'DRAW',
      status: 'CALCULATED',
      probability: 0.29,
      confidence: 40,
      evidenceConfidence: 8,
      evidenceLevel: 'PRIOR_ONLY',
      dataQuality: 0.12,
      isFinalSelection: false,
    },
    {
      key: 'AWAY_WIN',
      status: 'CALCULATED',
      probability: 0.23,
      confidence: 40,
      evidenceConfidence: 8,
      evidenceLevel: 'PRIOR_ONLY',
      dataQuality: 0.12,
      isFinalSelection: false,
    },
  ],
});

const grivitQuote = (eventId: string, selectionKey: string, revision = 2) => ({
  eventId,
  marketId: 'MATCH_RESULT',
  selectionKey,
  decimalOdds: selectionKey === 'HOME_WIN' ? 2.1 : selectionKey === 'DRAW' ? 3.2 : 3.8,
  priceType: 'ESTIMATED',
  predictionReady: true,
  isFresh: true,
  bookmaker: 'Grivit',
  pricingSource: 'GRIVIT_MODEL',
  oddsBasis: 'PRIOR_ONLY',
  calculationVersion: ODDS_CONFIG.modelVersion,
  fixtureSourceRevision: revision,
  sourceDataHash: `grivit-source-v${revision}`,
});

const fixture = (id: string, kickoffAt: Date, options: {
  homeTeamId?: string;
  awayTeamId?: string;
  state?: string;
} = {}) => ({
  id,
  competitionId: 'league-one',
  kickoffAt,
  status: {
    state: options.state ?? 'SCHEDULED',
    isFinal: false,
  },
  competitors: [
    {
      homeAway: 'HOME',
      teamId: options.homeTeamId === undefined ? `${id}-home` : options.homeTeamId,
    },
    {
      homeAway: 'AWAY',
      teamId: options.awayTeamId === undefined ? `${id}-away` : options.awayTeamId,
    },
  ],
});

describe('PredictionEngineMonitorService fixture coverage inventory', () => {
  it('reports match-level coverage, provisional evidence, queue gaps, failures and recalculation separately', async () => {
    const now = new Date();
    const coveredId = 'fixture-covered-prior-only';
    const failedId = 'fixture-failed-stale';
    const missingTeamId = 'fixture-missing-away-team';
    const outsideHorizonId = 'fixture-outside-horizon';

    const fixtures = [
      fixture(coveredId, new Date(now.getTime() + 24 * 60 * 60_000)),
      fixture(failedId, new Date(now.getTime() + 36 * 60 * 60_000)),
      fixture(missingTeamId, new Date(now.getTime() + 48 * 60 * 60_000), {
        awayTeamId: '',
      }),
      fixture(outsideHorizonId, new Date(now.getTime() + 10 * 24 * 60 * 60_000)),
    ];

    const service: any = Object.create(PredictionEngineMonitorService.prototype);

    service.sportsRead = {
      getFixtures: jest.fn().mockResolvedValue({ items: fixtures, nextCursor: null }),
      countFixtures: jest.fn().mockResolvedValue(fixtures.length),
    };
    service.queueModel = {
      find: jest.fn().mockReturnValue(query([{
        eventId: failedId,
        status: 'FAILED',
        modelVersion: PREDICTION_ENGINE_CONFIG.modelVersion,
        sourceRevisionFingerprint: 'sports-fingerprint-v1',
        errorMessage: 'Fixture calculation failed',
        attempts: 4,
        updatedAt: new Date(),
      }])),
    };
    service.marketModel = {
      find: jest.fn().mockReturnValue(query([
        predictionDocument(coveredId),
        predictionDocument(failedId, 'FAILED', 1),
      ])),
    };
    service.oddsRead = {
      getPricesForFixtures: jest.fn().mockResolvedValue([
        grivitQuote(coveredId, 'HOME_WIN'),
        grivitQuote(coveredId, 'DRAW'),
        grivitQuote(coveredId, 'AWAY_WIN'),
        grivitQuote(failedId, 'HOME_WIN', 1),
      ]),
    };
    service.sportsRevisions = {
      getCurrentRevisions: jest.fn().mockResolvedValue(new Map([
        [coveredId, 2],
        [failedId, 2],
        [missingTeamId, 0],
        [outsideHorizonId, 0],
      ])),
    };

    const result = await service.getFixtureCoverageInventory({
      from: now.toISOString(),
      to: new Date(now.getTime() + 14 * 24 * 60 * 60_000).toISOString(),
      pageSize: 50,
    });

    expect(result.totals).toMatchObject({
      sportsFixturesScanned: 4,
      eligibleFixtures: 3,
      excludedFixtures: 1,
      predictionRequiredFixtures: 2,
      oddsRequiredFixtures: 2,
      fixturesWithCurrentPrediction: 1,
      fixturesMissingCurrentPrediction: 1,
      fixturesWithCurrentGrivitOdds: 1,
      fixturesMissingCurrentGrivitOdds: 1,
      fixturesWithProvisionalPredictions: 1,
      fixturesWithProvisionalGrivitOdds: 1,
      fixturesWithProvisionalCalculations: 1,
      fixturesAwaitingRecalculation: 1,
      fixturesWithFailedCalculations: 1,
      fixturesWithPredictionQueueNotReady: 2,
      fixturesWithUnresolvedCoverageGaps: 1,
      fixturesMissingAwayTeamInformation: 1,
      fixturesOutsideConfiguredHorizons: 1,
      fullyCoveredFixtures: 1,
      predictionCoverageRate: 0.5,
      oddsCoverageRate: 0.5,
      endToEndCoverageRate: 0.5,
    });

    const covered = result.fixtures.find((item: any) => item.eventId === coveredId);
    expect(covered).toMatchObject({
      coverageState: 'PROVISIONAL_COVERAGE',
      queue: { present: false, covered: false },
      prediction: { covered: true, provisional: true, evidenceLevels: ['PRIOR_ONLY'] },
      odds: { covered: true, provisional: true, bases: ['PRIOR_ONLY'] },
      calculation: { failed: false },
    });
    expect(covered.issueCodes).toContain('PREDICTION_QUEUE_MISSING');

    const failed = result.fixtures.find((item: any) => item.eventId === failedId);
    expect(failed).toMatchObject({
      coverageState: 'FAILED_CALCULATION',
      recalculation: { required: true },
      calculation: { failed: true },
      queue: { status: 'FAILED', covered: false },
    });

    const missingTeam = result.fixtures.find((item: any) => item.eventId === missingTeamId);
    expect(missingTeam).toMatchObject({
      coverageState: 'MISSING_TEAM_INFORMATION',
      missingInformation: { teams: ['MISSING_AWAY_TEAM_ID'] },
    });

    const outsideHorizon = result.fixtures.find((item: any) => item.eventId === outsideHorizonId);
    expect(outsideHorizon.coverageState).toBe('OUTSIDE_REQUIRED_HORIZONS');
  });
});
