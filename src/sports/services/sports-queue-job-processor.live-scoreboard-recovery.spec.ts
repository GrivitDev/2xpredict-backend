import { SportsQueueJobProcessorService } from './sports-queue-job-processor.service';

function createFixture(scores: [number | null, number | null]) {
  return {
    id: 'fixture-1',
    espnEventId: 'event-1',
    competitionId: 'competition-1',
    seasonId: 'season-1',
    seasonYear: 2026,
    kickoffAt: new Date('2026-11-20T18:00:00.000Z'),
    completedAt: new Date('2026-11-20T20:00:00.000Z'),
    status: { state: 'COMPLETED', isFinal: true },
    competitors: [
      { teamId: 'home-1', homeAway: 'HOME', score: scores[0] },
      { teamId: 'away-1', homeAway: 'AWAY', score: scores[1] },
    ],
  } as any;
}

function createService(fixture: any) {
  const service = Object.create(
    SportsQueueJobProcessorService.prototype,
  ) as any;
  service.collection = {
    getCompetition: jest.fn().mockResolvedValue({
      id: 'competition-1',
      slug: 'eng.1',
    }),
    getFixturesForCompetitionDate: jest.fn().mockResolvedValue([fixture]),
  };
  service.youtubeHighlights = {
    ensureFirstAttempt: jest.fn().mockResolvedValue(true),
  };
  service.dateKey = jest.fn().mockReturnValue('2026-11-20');
  service.enqueueSummary = jest.fn().mockResolvedValue(undefined);
  service.enqueuePlays = jest.fn().mockResolvedValue(undefined);
  service.enqueueLeagueNews = jest.fn().mockResolvedValue(undefined);
  service.enqueueMilestone = jest.fn().mockResolvedValue(undefined);
  service.scheduleLiveScoreboard = jest.fn().mockResolvedValue(undefined);
  service.logger = { warn: jest.fn(), log: jest.fn(), debug: jest.fn() };
  return service;
}

describe('SportsQueueJobProcessorService scoreless final-fixture recovery', () => {
  it('schedules date-level verification when a completed fixture has no final scores', async () => {
    const fixture = createFixture([null, null]);
    const service = createService(fixture);

    await service.scheduleFixtureJobs(
      [fixture],
      'scoreless-completed-fixture',
      false,
    );

    expect(service.scheduleLiveScoreboard).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'competition-1', slug: 'eng.1' }),
      fixture,
      undefined,
    );
  });

  it('does not schedule another status monitor when a completed fixture already has both scores', async () => {
    const fixture = createFixture([2, 1]);
    const service = createService(fixture);

    await service.scheduleFixtureJobs(
      [fixture],
      'completed-fixture-with-score',
      false,
    );

    expect(service.scheduleLiveScoreboard).not.toHaveBeenCalled();
  });
});
