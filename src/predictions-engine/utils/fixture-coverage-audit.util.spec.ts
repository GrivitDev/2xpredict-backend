import {
  evaluateFixtureCoverage,
  FixtureCoverageAuditInput,
} from './fixture-coverage-audit.util';

const NOW = new Date('2026-11-23T12:00:00.000Z');
const FUTURE = new Date('2026-11-25T12:00:00.000Z');

const predictionDocument = {
  modelVersion: '2XP-FOOTBALL-3.2.0',
  status: 'CALCULATED',
  fixtureSourceRevision: 4,
  sourceRevisionFingerprint: 'sports-fingerprint-v4',
  selections: [
    { key: 'HOME_WIN', status: 'CALCULATED', probability: 0.48, confidence: 40, evidenceConfidence: 8, evidenceLevel: 'PRIOR_ONLY', dataQuality: 0.12, isFinalSelection: true },
    { key: 'DRAW', status: 'CALCULATED', probability: 0.29, confidence: 40, evidenceConfidence: 8, evidenceLevel: 'PRIOR_ONLY', dataQuality: 0.12, isFinalSelection: false },
    { key: 'AWAY_WIN', status: 'CALCULATED', probability: 0.23, confidence: 40, evidenceConfidence: 8, evidenceLevel: 'PRIOR_ONLY', dataQuality: 0.12, isFinalSelection: false },
  ],
};

const oddsQuotes = [
  'HOME_WIN',
  'DRAW',
  'AWAY_WIN',
].map((selectionKey, index) => ({
  selectionKey,
  decimalOdds: [2.1, 3.2, 3.8][index],
  priceType: 'ESTIMATED',
  pricingSource: 'GRIVIT_MODEL',
  predictionReady: true,
  isFresh: true,
  oddsBasis: 'PRIOR_ONLY',
  calculationVersion: '2XP-ODDS-4.2.0',
  fixtureSourceRevision: 4,
  sourceDataHash: 'grivit-source-v4',
}));

const completeInput = (): FixtureCoverageAuditInput => ({
  now: NOW,
  kickoffAt: FUTURE,
  fixtureStatus: { state: 'SCHEDULED', isFinal: false },
  homeTeamId: 'team-home',
  awayTeamId: 'team-away',
  predictionHorizonHours: 168,
  oddsHorizonHours: 168,
  predictionModelVersion: '2XP-FOOTBALL-3.2.0',
  oddsModelVersion: '2XP-ODDS-4.2.0',
  maximumDecimalOdds: 100_000,
  currentFixtureSourceRevision: 4,
  queue: {
    status: 'COMPLETED',
    modelVersion: '2XP-FOOTBALL-3.2.0',
    sourceRevisionFingerprint: 'sports-fingerprint-v4',
  },
  predictionDocument,
  oddsQuotes,
});

describe('evaluateFixtureCoverage', () => {
  it('marks a fixture fully covered when the complete baseline 1X2 is current', () => {
    const result = evaluateFixtureCoverage(completeInput());

    expect(result.eligible).toBe(true);
    expect(result.predictionRequired).toBe(true);
    expect(result.oddsRequired).toBe(true);
    expect(result.predictionSelectionCount).toBe(3);
    expect(result.oddsSelectionCount).toBe(3);
    expect(result.probabilityTotal).toBeCloseTo(1, 8);
    expect(result.predictionCovered).toBe(true);
    expect(result.oddsCovered).toBe(true);
    expect(result.fullyCovered).toBe(true);
    expect(result.issueCodes).toEqual([]);
  });

  it('detects a fixture missing from the durable Prediction queue', () => {
    const input = completeInput();
    input.queue = null;

    const result = evaluateFixtureCoverage(input);

    expect(result.predictionCovered).toBe(true);
    expect(result.queuePresent).toBe(false);
    expect(result.queueCovered).toBe(false);
    // The already-persisted 1X2 outputs remain covered; the queue gap is
    // reported separately because queue presence is not a prediction result.
    expect(result.fullyCovered).toBe(true);
    expect(result.issueCodes).toContain('PREDICTION_QUEUE_MISSING');
  });

  it('detects missing baseline Grivit prices without treating advanced markets as required', () => {
    const input = completeInput();
    input.oddsQuotes = [];

    const result = evaluateFixtureCoverage(input);

    expect(result.oddsCovered).toBe(false);
    expect(result.issueCodes).toContain('GRIVIT_BASELINE_ODDS_MISSING');
    expect(result.issueCodes).not.toContain('ADVANCED_MARKET_MISSING');
  });

  it('detects stale Prediction and Grivit snapshots after a fixture revision changes', () => {
    const input = completeInput();
    input.currentFixtureSourceRevision = 5;

    const result = evaluateFixtureCoverage(input);

    expect(result.predictionCovered).toBe(false);
    expect(result.oddsCovered).toBe(false);
    expect(result.issueCodes).toContain('BASELINE_PREDICTION_SOURCE_REVISION_STALE');
    expect(result.issueCodes).toContain('GRIVIT_BASELINE_ODDS_SOURCE_REVISION_STALE');
  });

  it('does not count fixtures without normalized participant identities as eligible gaps', () => {
    const input = completeInput();
    input.awayTeamId = '';
    input.queue = null;
    input.predictionDocument = null;
    input.oddsQuotes = [];

    const result = evaluateFixtureCoverage(input);

    expect(result.eligible).toBe(false);
    expect(result.predictionRequired).toBe(false);
    expect(result.oddsRequired).toBe(false);
    expect(result.fullyCovered).toBe(false);
    expect(result.exclusionReasons).toContain('MISSING_AWAY_TEAM_ID');
    expect(result.issueCodes).toEqual([]);
  });

  it('detects a 1X2 probability set that is not normalized to 100 percent', () => {
    const input = completeInput();
    input.predictionDocument = {
      ...predictionDocument,
      selections: predictionDocument.selections.map((selection) => ({
        ...selection,
        probability: selection.probability + 0.03,
      })),
    };

    const result = evaluateFixtureCoverage(input);

    expect(result.predictionCovered).toBe(false);
    expect(result.issueCodes).toContain('BASELINE_PREDICTION_PROBABILITIES_NOT_NORMALIZED');
  });

  it('detects missing or invalid evidence metadata separately from displayed confidence', () => {
    const input = completeInput();
    input.predictionDocument = {
      ...predictionDocument,
      selections: predictionDocument.selections.map((selection, index) => ({
        ...selection,
        evidenceLevel: index === 0 ? undefined : selection.evidenceLevel,
      })),
    };

    const result = evaluateFixtureCoverage(input);

    expect(result.predictionCovered).toBe(false);
    expect(result.issueCodes).toContain('BASELINE_PREDICTION_EVIDENCE_METADATA_INVALID');
  });

  it('detects baseline confidence below the configured display floor', () => {
    const input = completeInput();
    input.predictionDocument = {
      ...predictionDocument,
      selections: predictionDocument.selections.map((selection, index) => ({
        ...selection,
        confidence: index === 0 ? 39 : 40,
      })),
    };

    const result = evaluateFixtureCoverage(input);

    expect(result.predictionCovered).toBe(false);
    expect(result.issueCodes).toContain('BASELINE_PREDICTION_CONFIDENCE_INVALID');
  });

  it('does not report fixtures outside both configured horizons as covered work', () => {
    const input = completeInput();
    input.kickoffAt = new Date(NOW.getTime() + 240 * 3_600_000);
    input.predictionHorizonHours = 72;
    input.oddsHorizonHours = 168;
    input.queue = null;
    input.predictionDocument = null;
    input.oddsQuotes = [];

    const result = evaluateFixtureCoverage(input);

    expect(result.predictionRequired).toBe(false);
    expect(result.oddsRequired).toBe(false);
    expect(result.fullyCovered).toBe(false);
    expect(result.issueCodes).toEqual([]);
  });



  it('reports baseline-only predictions and prices as provisional without rejecting coverage', () => {
    const result = evaluateFixtureCoverage(completeInput());

    expect(result.predictionCovered).toBe(true);
    expect(result.oddsCovered).toBe(true);
    expect(result.fullyCovered).toBe(true);
    expect(result.predictionProvisional).toBe(true);
    expect(result.predictionEvidenceLevels).toEqual(['PRIOR_ONLY']);
    expect(result.oddsProvisional).toBe(true);
    expect(result.oddsBases).toEqual(['PRIOR_ONLY']);
  });

  it('marks changed fixture revisions as pending recalculation', () => {
    const input = completeInput();
    input.currentFixtureSourceRevision = 5;

    const result = evaluateFixtureCoverage(input);

    expect(result.pendingRecalculation).toBe(true);
  });

  it('distinguishes failed calculation records from ordinary missing outputs', () => {
    const input = completeInput();
    input.queue = {
      status: 'FAILED',
      modelVersion: '2XP-FOOTBALL-3.2.0',
      sourceRevisionFingerprint: 'sports-fingerprint-v4',
    };
    input.predictionDocument = {
      ...predictionDocument,
      status: 'FAILED',
    };

    const result = evaluateFixtureCoverage(input);

    expect(result.failedCalculation).toBe(true);
    expect(result.queueCovered).toBe(false);
    expect(result.issueCodes).toContain('PREDICTION_QUEUE_FAILED');
    expect(result.issueCodes).toContain('BASELINE_PREDICTION_FAILED');
  });

  it('classifies missing kickoff and participant information separately', () => {
    const input = completeInput();
    input.kickoffAt = 'not-a-date';
    input.homeTeamId = '';

    const result = evaluateFixtureCoverage(input);

    expect(result.eligible).toBe(false);
    expect(result.missingFixtureInformation).toContain('INVALID_KICKOFF');
    expect(result.missingTeamInformation).toContain('MISSING_HOME_TEAM_ID');
  });

  it('does not require a Prediction outside its configured horizon', () => {
    const input = completeInput();
    input.kickoffAt = new Date(NOW.getTime() + 100 * 3_600_000);
    input.predictionHorizonHours = 72;
    input.oddsHorizonHours = 168;
    input.queue = null;
    input.predictionDocument = null;

    const result = evaluateFixtureCoverage(input);

    expect(result.predictionRequired).toBe(false);
    expect(result.oddsRequired).toBe(true);
    expect(result.oddsCovered).toBe(true);
    expect(result.issueCodes).not.toContain('PREDICTION_QUEUE_MISSING');
  });
});
