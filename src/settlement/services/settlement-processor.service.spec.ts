import { SettlementProcessorService } from './settlement-processor.service';

const makeMatch = (state: 'COMPLETED' | 'LIVE' = 'COMPLETED') => ({
  fixture: {
    id: 'fixture-1',
    espnEventId: 'espn-1',
    competitionId: 'competition-1',
    seasonId: 'season-1',
    seasonYear: 2026,
    status: { state, isFinal: state === 'COMPLETED' },
    competitors: [],
  },
  competition: { id: 'competition-1', slug: 'eng.1', name: 'Premier League' },
  season: null,
  homeTeam: null,
  awayTeam: null,
  timeline: [],
  latestOdds: null,
}) as any;

const makeFacts = (timelineCoverageComplete: boolean) => ({
  eventId: 'fixture-1',
  leagueId: 'competition-1',
  homeTeamId: 'team-home',
  awayTeamId: 'team-away',
  homeTeamName: 'Home FC',
  awayTeamName: 'Away FC',
  isFinished: true,
  fixtureState: 'COMPLETED',
  firstHalfComplete: true,
  secondHalfComplete: true,
  homeGoals: 0,
  awayGoals: 0,
  periodScoresAvailable: false,
  goalEventsComplete: timelineCoverageComplete,
  eventDetailsAvailable: false,
  timelineCoverageComplete,
  homeStats: timelineCoverageComplete ? { shots: 10 } : {},
  awayStats: timelineCoverageComplete ? { shots: 8 } : {},
  playerStats: {},
  playerNames: {},
  goals: [],
  cards: [],
  settlementBlockers: [],
  sourceDiagnostics: [],
  conflictingStats: [],
  homeStatisticsCollectedAt: timelineCoverageComplete ? new Date() : undefined,
  awayStatisticsCollectedAt: timelineCoverageComplete ? new Date() : undefined,
  sourceFingerprint: timelineCoverageComplete ? 'fresh-source' : 'old-source',
});

const createProcessor = (input?: { initialState?: 'COMPLETED' | 'LIVE' }) => {
  const initialMatch = makeMatch(input?.initialState ?? 'COMPLETED');
  const refreshedMatch = makeMatch('COMPLETED');
  const sportsRead = {
    getMatch: jest.fn()
      .mockResolvedValueOnce(initialMatch)
      .mockResolvedValue(refreshedMatch),
  };
  const sportsCollection = {
    hasCompleteMatchPlays: jest.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true),
    shouldCollectFixtureSummary: jest.fn().mockResolvedValue(true),
    collectFixtureSummary: jest.fn().mockResolvedValue(refreshedMatch.fixture),
    normalizeStoredMatchSummary: jest.fn().mockResolvedValue(true),
    shouldCollectMatchPlays: jest.fn().mockResolvedValue(true),
    collectMatchPlays: jest.fn().mockResolvedValue({ items: [], fallbackUsed: false }),
  };
  const factsService = {
    extract: jest.fn((_match: unknown, options?: { timelineCoverageComplete?: boolean }) =>
      makeFacts(options?.timelineCoverageComplete === true)),
  };
  const run = { _id: 'run-1' };
  const runModel = {
    findOneAndUpdate: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(run) }),
    updateOne: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }) }),
  };
  const marketPredictionModel = {};
  const predictionSettlementService = { settleEvent: jest.fn().mockResolvedValue(undefined) };
  const betLabSettlementService = { settleEvent: jest.fn().mockResolvedValue(undefined) };
  const eventLog = { write: jest.fn().mockResolvedValue(undefined) };
  const queue = {
    assertProcessingLease: jest.fn().mockResolvedValue(undefined),
    ownsProcessingLease: jest.fn().mockResolvedValue(true),
  };

  const processor = new SettlementProcessorService(
    runModel as any,
    marketPredictionModel as any,
    sportsRead as any,
    sportsCollection as any,
    factsService as any,
    predictionSettlementService as any,
    betLabSettlementService as any,
    eventLog as any,
    queue as any,
  );

  return {
    processor,
    sportsRead,
    sportsCollection,
    factsService,
    predictionSettlementService,
    betLabSettlementService,
  };
};

describe('SettlementProcessorService evidence recovery', () => {
  const job = {
    eventId: 'fixture-1',
    jobKey: 'settle:fixture-1',
    sourceFingerprint: 'initial-source',
  } as any;

  it('refreshes missing final Summary and Plays evidence, then rereads Sports before grading', async () => {
    const {
      processor,
      sportsRead,
      sportsCollection,
      factsService,
      predictionSettlementService,
      betLabSettlementService,
    } = createProcessor();

    await processor.process(job);

    expect(sportsCollection.shouldCollectFixtureSummary).toHaveBeenCalledWith(
      'espn-1',
      expect.any(Number),
    );
    expect(sportsCollection.collectFixtureSummary).toHaveBeenCalledWith(
      'eng.1',
      'espn-1',
      { competitionId: 'competition-1', seasonId: 'season-1', seasonYear: 2026 },
    );
    expect(sportsCollection.shouldCollectMatchPlays).toHaveBeenCalledWith('fixture-1');
    expect(sportsCollection.collectMatchPlays).toHaveBeenCalledWith(expect.objectContaining({ id: 'fixture-1' }));
    expect(sportsRead.getMatch).toHaveBeenCalledTimes(2);
    expect(factsService.extract).toHaveBeenLastCalledWith(
      expect.objectContaining({ fixture: expect.objectContaining({ id: 'fixture-1' }) }),
      { timelineCoverageComplete: true },
    );
    expect(predictionSettlementService.settleEvent).toHaveBeenCalledTimes(1);
    expect(betLabSettlementService.settleEvent).toHaveBeenCalledTimes(1);
  });


  it('re-normalizes a retained raw Summary locally when the fact revision is missing or outdated', async () => {
    const { processor, sportsRead, sportsCollection } = createProcessor();
    const initial = makeMatch('COMPLETED');
    initial.matchSummary = { fixtureId: 'fixture-1', espnEventId: 'espn-1', payloadHash: 'raw-hash', revision: 2 };
    initial.matchFacts = { sourcePayloadHash: 'old-hash', normalizationVersion: '1.0.0' };
    sportsRead.getMatch.mockReset()
      .mockResolvedValueOnce(initial)
      .mockResolvedValue(makeMatch('COMPLETED'));

    await processor.process(job);

    expect(sportsCollection.normalizeStoredMatchSummary).toHaveBeenCalledWith(expect.objectContaining({ id: 'fixture-1' }));
    expect(sportsRead.getMatch).toHaveBeenCalledTimes(3);
  });

  it('re-reads Sports after Summary collection even when fixture normalization returns null', async () => {
    const { processor, sportsRead, sportsCollection } = createProcessor();
    sportsCollection.collectFixtureSummary.mockResolvedValueOnce(null);

    await processor.process(job);

    expect(sportsCollection.collectFixtureSummary).toHaveBeenCalledTimes(1);
    expect(sportsRead.getMatch).toHaveBeenCalledTimes(2);
  });

  it('does not call full-time recovery providers for a live fixture', async () => {
    const { processor, sportsCollection, sportsRead } = createProcessor({ initialState: 'LIVE' });

    await processor.process(job);

    expect(sportsCollection.shouldCollectFixtureSummary).not.toHaveBeenCalled();
    expect(sportsCollection.collectFixtureSummary).not.toHaveBeenCalled();
    expect(sportsCollection.shouldCollectMatchPlays).not.toHaveBeenCalled();
    expect(sportsCollection.collectMatchPlays).not.toHaveBeenCalled();
    expect(sportsRead.getMatch).toHaveBeenCalledTimes(1);
  });
});

