import { SportsPersistenceService } from './sports-persistence.service';

const makeInput = (overrides: Record<string, unknown> = {}) => ({
  fixtureId: 'fixture-1',
  espnEventId: 'espn-1',
  competitionId: 'competition-1',
  seasonId: 'season-1',
  provider: 'ESPN' as const,
  endpoint: '/summary?event=espn-1',
  sourcePayloadHash: 'payload-hash-1',
  sourceRevision: 1,
  sourceCollectedAt: new Date('2026-11-11T11:00:00.000Z'),
  normalizationVersion: '1.1.0',
  normalizationHash: 'normalization-hash-1',
  normalizedAt: new Date('2026-11-11T11:00:01.000Z'),
  matchResult: {
    homeTeamId: 'team-home',
    awayTeamId: 'team-away',
    homeScore: 1,
    awayScore: 0,
    isFinal: true,
    available: true,
    scoreSource: 'ESPN_SUMMARY' as const,
  },
  periodScores: [],
  teamStatistics: [
    { teamId: 'team-home', espnTeamId: '1', side: 'HOME' as const, statistics: [] },
    { teamId: 'team-away', espnTeamId: '2', side: 'AWAY' as const, statistics: [] },
  ],
  playerAppearances: [{ playerId: 'athlete:1', espnPlayerId: '1', appearances: 1, appearanceBasis: 'LINEUP_PARTICIPATION' as const, statistics: [] }],
  leaders: [],
  summaryEvents: [],
  sectionStatus: {
    matchResult: 'COMPLETE' as const,
    periodScores: 'NOT_PROVIDED' as const,
    teamStatistics: 'NOT_PROVIDED' as const,
    playerAppearances: 'AVAILABLE' as const,
    playerStatistics: 'NOT_PROVIDED' as const,
    leaders: 'NOT_PROVIDED' as const,
    summaryEvents: 'NOT_PROVIDED' as const,
  },
  diagnostics: [],
  ...overrides,
});

function createHarness(existing: Record<string, unknown> | null = null) {
  const session = {
    withTransaction: jest.fn(async (work: () => Promise<void>) => work()),
    endSession: jest.fn().mockResolvedValue(undefined),
  };
  const query = {
    select: jest.fn().mockReturnThis(),
    session: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(existing),
  };
  const matchFactsModel = {
    db: { startSession: jest.fn().mockResolvedValue(session) },
    findOne: jest.fn().mockReturnValue(query),
    updateOne: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({ upsertedCount: 1 }) }),
  };
  const changeEvents = {
    enqueueChanged: jest.fn().mockResolvedValue(true),
    notifyWorker: jest.fn(),
  };
  const service = Object.create(SportsPersistenceService.prototype) as SportsPersistenceService;
  Object.assign(service, { matchFactsModel, changeEvents });
  return { service, session, query, matchFactsModel, changeEvents };
}

describe('SportsPersistenceService Summary facts outbox integration', () => {
  it('persists changed Summary facts and queues MATCH_STATISTICS in the same transaction', async () => {
    const h = createHarness();
    const result = await h.service.saveMatchFacts(makeInput() as any);

    expect(result).toEqual({ revision: 1, changed: true });
    expect(h.session.withTransaction).toHaveBeenCalledTimes(1);
    expect(h.matchFactsModel.updateOne).toHaveBeenCalledWith(
      { fixtureId: 'fixture-1' },
      expect.objectContaining({ $set: expect.objectContaining({ revision: 1 }) }),
      expect.objectContaining({ session: h.session, upsert: true }),
    );
    expect(h.changeEvents.enqueueChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: 'MATCH_STATISTICS',
        entityId: 'fixture-1',
        competitionIds: ['competition-1'],
        seasonIds: ['season-1'],
        fixtureIds: ['fixture-1'],
        teamIds: ['team-home', 'team-away'],
        athleteIds: ['athlete:1'],
      }),
      h.session,
    );
    expect(h.changeEvents.notifyWorker).toHaveBeenCalledTimes(1);
    expect(h.session.endSession).toHaveBeenCalledTimes(1);
  });

  it('does not emit another event for the same normalized snapshot and collection time', async () => {
    const input = makeInput();
    const h = createHarness({
      normalizationHash: 'normalization-hash-1',
      sourcePayloadHash: 'payload-hash-1',
      sourceCollectedAt: input.sourceCollectedAt,
      normalizationVersion: '1.1.0',
      revision: 4,
    });
    const result = await h.service.saveMatchFacts(input as any);

    expect(result).toEqual({ revision: 4, changed: false });
    expect(h.changeEvents.enqueueChanged).not.toHaveBeenCalled();
    expect(h.changeEvents.notifyWorker).not.toHaveBeenCalled();
  });

  it('does not overwrite a newer normalized Summary snapshot with an older in-flight response', async () => {
    const newer = new Date('2026-11-11T12:00:00.000Z');
    const input = makeInput({ sourceCollectedAt: new Date('2026-11-11T11:00:00.000Z') });
    const h = createHarness({
      normalizationHash: 'newer-hash',
      sourcePayloadHash: 'newer-payload',
      sourceCollectedAt: newer,
      normalizationVersion: '1.1.0',
      revision: 9,
    });
    const result = await h.service.saveMatchFacts(input as any);

    expect(result).toEqual({ revision: 9, changed: false });
    expect(h.matchFactsModel.updateOne).not.toHaveBeenCalled();
    expect(h.changeEvents.enqueueChanged).not.toHaveBeenCalled();
  });
});
