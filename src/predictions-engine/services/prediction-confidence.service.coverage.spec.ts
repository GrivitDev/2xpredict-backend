import { MarketModel } from '../enums/market-model.enum';
import { PredictionConfidenceService } from './prediction-confidence.service';

describe('PredictionConfidenceService baseline confidence floor', () => {
  it('keeps the display confidence at least 40 while preserving the raw evidence score', () => {
    const service = new PredictionConfidenceService();
    const context = {
      fixture: {
        eventId: 'fixture-prior-only',
        homeTeamId: 'team-home',
        awayTeamId: 'team-away',
        fixtureDate: new Date('2026-12-01T12:00:00.000Z'),
      },
      historicalFixtures: [],
      leagueFixtures: [],
      hasOdds: false,
      hasHeadToHead: false,
      hasStandings: false,
      hasPlayerAppearanceEvidence: false,
      sportsDataAgeHours: null,
      summaryAvailable: false,
    } as any;
    const modelEvidence = {
      homeSamples: 0,
      awaySamples: 0,
      leagueSamples: 0,
      historicalHeadToHeadMatches: 0,
      homeRecentFormSamples: 0,
      awayRecentFormSamples: 0,
      standingsStrengthAvailable: false,
      independentEvidenceAvailable: false,
      evidenceLevel: 'PRIOR_ONLY',
    } as any;

    const result = service.calculate(
      context,
      0,
      false,
      'fixture-prior-only:MATCH_RESULT:HOME_WIN',
      modelEvidence,
      MarketModel.SCORE_MATRIX,
    );

    expect(result.confidence).toBeGreaterThanOrEqual(40);
    expect(result.evidenceConfidence).toBeLessThan(40);
    expect(result.dataQuality).toBeLessThan(0.4);
    expect(result.evidenceLevel).toBe('PRIOR_ONLY');
    expect(result.notes.some((note) => note.includes('PRIOR_ONLY evidence'))).toBe(true);
  });

  it('uses the evidence tier to distinguish limited and developing information', () => {
    const service = new PredictionConfidenceService();
    const context = {
      fixture: {
        eventId: 'fixture-evidence',
        homeTeamId: 'team-home',
        awayTeamId: 'team-away',
        fixtureDate: new Date('2026-12-01T12:00:00.000Z'),
      },
      historicalFixtures: [],
      leagueFixtures: [],
      hasOdds: false,
      hasHeadToHead: false,
      hasStandings: false,
      hasPlayerAppearanceEvidence: false,
      sportsDataAgeHours: null,
      summaryAvailable: true,
    } as any;

    const limited = service.calculate(context, 0.2, false, 'limited', {
      homeSamples: 1, awaySamples: 0, leagueSamples: 1,
      historicalHeadToHeadMatches: 0, homeRecentFormSamples: 1, awayRecentFormSamples: 0,
      standingsStrengthAvailable: false, independentEvidenceAvailable: true,
      evidenceLevel: 'LIMITED',
    } as any, MarketModel.SCORE_MATRIX);
    const developing = service.calculate(context, 0.55, false, 'developing', {
      homeSamples: 3, awaySamples: 3, leagueSamples: 8,
      historicalHeadToHeadMatches: 1, homeRecentFormSamples: 3, awayRecentFormSamples: 3,
      standingsStrengthAvailable: true, independentEvidenceAvailable: true,
      evidenceLevel: 'DEVELOPING',
    } as any, MarketModel.SCORE_MATRIX);

    expect(limited.evidenceLevel).toBe('LIMITED');
    expect(developing.evidenceLevel).toBe('DEVELOPING');
    expect(developing.evidenceConfidence).toBeGreaterThan(limited.evidenceConfidence);
  });

  it('conservatively discounts displayed confidence when settled model reliability is poor', () => {
    const service = new PredictionConfidenceService();
    const context = {
      fixture: {
        eventId: 'fixture-calibrated',
        homeTeamId: 'team-home',
        awayTeamId: 'team-away',
        fixtureDate: new Date('2026-12-01T12:00:00.000Z'),
      },
      historicalFixtures: [],
      leagueFixtures: [],
      hasOdds: false,
      hasHeadToHead: false,
      hasStandings: false,
      hasPlayerAppearanceEvidence: false,
      sportsDataAgeHours: 1,
      summaryAvailable: true,
    } as any;
    const modelEvidence = {
      homeSamples: 5, awaySamples: 5, leagueSamples: 24,
      historicalHeadToHeadMatches: 3, homeRecentFormSamples: 5, awayRecentFormSamples: 5,
      standingsStrengthAvailable: true, independentEvidenceAvailable: true,
      evidenceLevel: 'STRONG',
    } as any;
    const withoutCalibration = service.calculate(context, 0.85, false, 'plain', modelEvidence, MarketModel.SCORE_MATRIX);
    const withPoorCalibration = service.calculate(context, 0.85, false, 'poor', modelEvidence, MarketModel.SCORE_MATRIX, {
      active: true,
      sampleSize: 120,
      reliabilityScore: 0,
    });

    expect(withPoorCalibration.evidenceConfidence).toBe(withoutCalibration.evidenceConfidence);
    expect(withPoorCalibration.confidence).toBeLessThanOrEqual(withoutCalibration.confidence);
    expect(withPoorCalibration.confidence).toBeGreaterThanOrEqual(40);
    expect(withPoorCalibration.signals.historicalCalibrationPenalty).toBeGreaterThan(0);
    expect(withPoorCalibration.notes.some((note) => note.includes('Historical outcome calibration'))).toBe(true);
  });
});
