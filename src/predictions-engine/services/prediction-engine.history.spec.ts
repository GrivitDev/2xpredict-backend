import { PredictionEngineService } from './prediction-engine.service';

describe('PredictionEngineService calculation history', () => {
  it('creates a stable append-only snapshot operation for a replaced market', () => {
    const service = Object.create(PredictionEngineService.prototype) as any;
    const calculatedAt = new Date('2026-11-20T10:00:00.000Z');
    const existing = {
      _id: 'market-row-1',
      eventId: 'fixture-1',
      marketKey: 'MATCH_RESULT',
      modelVersion: '2XP-PRED-4.0.0',
      fixtureSourceRevision: 5,
      sourceRevisionFingerprint: 'source-generation-5',
      generatedAt: calculatedAt,
      retentionExpiresAt: new Date('2027-04-01T00:00:00.000Z'),
      selections: [
        { key: 'HOME_WIN', probability: 0.48, confidence: 55 },
        { key: 'DRAW', probability: 0.28, confidence: 55 },
        { key: 'AWAY_WIN', probability: 0.24, confidence: 55 },
      ],
    };

    const first = service.createMarketHistoryOperation(existing);
    const second = service.createMarketHistoryOperation(existing);

    expect(first.updateOne.filter.snapshotId).toMatch(/^[a-f0-9]{64}$/);
    expect(second.updateOne.filter.snapshotId).toBe(first.updateOne.filter.snapshotId);
    expect(first.updateOne.update.$setOnInsert).toEqual(expect.objectContaining({
      eventId: 'fixture-1',
      marketKey: 'MATCH_RESULT',
      modelVersion: '2XP-PRED-4.0.0',
      fixtureSourceRevision: 5,
      sourceRevisionFingerprint: 'source-generation-5',
      calculatedAt,
      retentionExpiresAt: existing.retentionExpiresAt,
      snapshot: existing,
    }));
    expect(first.updateOne.upsert).toBe(true);
  });
});
