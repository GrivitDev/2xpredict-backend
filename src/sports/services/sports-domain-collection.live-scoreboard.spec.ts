import { SportsDomainCollectionService } from './sports-domain-collection.service';

const makeFixture = (state: string, kickoffAt: Date, isFinal = false) => ({
  status: { state, isFinal },
  kickoffAt,
  competitors:
    state === 'COMPLETED' || isFinal
      ? [{ score: 1 }, { score: 0 }]
      : [{ score: null }, { score: null }],
});

describe('SportsDomainCollectionService live scoreboard lifecycle', () => {
  const makeService = (fixtures: any[]) => {
    const service = Object.create(SportsDomainCollectionService.prototype) as any;
    service.persistence = {
      getFixturesForCompetitionDate: jest.fn().mockResolvedValue(fixtures),
    };
    return service;
  };

  it('keeps one-minute polling during the first four hours after kickoff', async () => {
    const kickoff = Date.parse('2026-11-16T10:00:00.000Z');
    const service = makeService([makeFixture('SCHEDULED', new Date(kickoff))]);
    await expect(service.getLiveScoreboardMonitoringState(
      'competition-1', '2026-11-16', new Date(kickoff).toISOString(), kickoff + 3 * 60 * 60_000,
    )).resolves.toMatchObject({ shouldContinue: true, intervalMs: 60_000 });
  });

  it('switches stale scheduled fixtures to thirty-minute verification after four hours', async () => {
    const kickoff = Date.parse('2026-11-15T10:00:00.000Z');
    const service = makeService([makeFixture('SCHEDULED', new Date(kickoff))]);
    await expect(service.getLiveScoreboardMonitoringState(
      'competition-1', '2026-11-15', new Date(kickoff).toISOString(), kickoff + 30 * 60 * 60_000,
    )).resolves.toMatchObject({ shouldContinue: true, intervalMs: 30 * 60_000 });
  });

  it('uses persisted fixture kickoff when the queue scope kickoff is missing or invalid', async () => {
    const kickoff = Date.parse('2026-11-15T10:00:00.000Z');
    const service = makeService([makeFixture('SCHEDULED', new Date(kickoff))]);
    await expect(service.getLiveScoreboardMonitoringState(
      'competition-1', '2026-11-15', 'not-a-date', kickoff + 5 * 60 * 60_000,
    )).resolves.toMatchObject({
      shouldContinue: true, intervalMs: 30 * 60_000,
      anchorKickoffAt: new Date(kickoff).toISOString(),
    });
  });

  it('uses calendar date as fallback when kickoff metadata is unavailable', async () => {
    const service = makeService([makeFixture('SCHEDULED', new Date(Number.NaN))]);
    await expect(service.getLiveScoreboardMonitoringState(
      'competition-1', '2026-11-16', undefined, Date.parse('2026-11-16T06:00:00.000Z'),
    )).resolves.toMatchObject({ shouldContinue: true, intervalMs: 30 * 60_000 });
  });

  it.each(['COMPLETED', 'POSTPONED', 'CANCELLED', 'ABANDONED'])(
    'stops recurring checks when ESPN confirms %s', async (state) => {
      const service = makeService([makeFixture(
        state, new Date('2026-11-15T10:00:00.000Z'), state === 'COMPLETED',
      )]);
      await expect(service.getLiveScoreboardMonitoringState(
        'competition-1', '2026-11-15',
      )).resolves.toEqual({ shouldContinue: false });
    },
  );

  it('continues low-frequency verification for UNKNOWN fixtures, including unresolved suspended matches', async () => {
    const kickoff = Date.parse('2026-11-15T10:00:00.000Z');
    const service = makeService([makeFixture('UNKNOWN', new Date(kickoff))]);
    await expect(service.getLiveScoreboardMonitoringState(
      'competition-1', '2026-11-15', undefined, kickoff + 5 * 60 * 60_000,
    )).resolves.toMatchObject({ shouldContinue: true, intervalMs: 30 * 60_000 });
  });



  it('continues six-hour verification when ESPN says COMPLETED but omits one or both final scores', async () => {
    const kickoff = Date.parse('2026-11-15T10:00:00.000Z');
    const completedWithoutScores = {
      ...makeFixture('COMPLETED', new Date(kickoff), true),
      competitors: [{ score: null }, { score: null }],
    };
    const service = makeService([completedWithoutScores]);
    await expect(service.getLiveScoreboardMonitoringState(
      'competition-1',
      '2026-11-15',
      new Date(kickoff).toISOString(),
      kickoff + 72 * 60 * 60_000,
    )).resolves.toMatchObject({
      shouldContinue: true,
      intervalMs: 6 * 60 * 60_000,
    });
  });

  it('switches unresolved fixtures to six-hour verification after forty-eight hours', async () => {
    const kickoff = Date.parse('2026-11-15T10:00:00.000Z');
    const service = makeService([makeFixture('LIVE', new Date(kickoff))]);
    await expect(service.getLiveScoreboardMonitoringState(
      'competition-1',
      '2026-11-15',
      new Date(kickoff).toISOString(),
      kickoff + 72 * 60 * 60_000,
    )).resolves.toMatchObject({
      shouldContinue: true,
      intervalMs: 6 * 60 * 60_000,
    });
  });
});

