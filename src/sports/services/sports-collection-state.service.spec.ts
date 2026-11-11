import { Model } from 'mongoose';
import {
  SportsCollectionStateDocument,
  SportsFixtureValidationResult,
} from '../schemas/operations/sports-collection-state.schema';
import { SportsCollectionStateService } from './sports-collection-state.service';

describe('SportsCollectionStateService update contracts', () => {
  let service: SportsCollectionStateService;
  let updateOne: jest.Mock;
  let find: jest.Mock;
  let queueFindOne: jest.Mock;

  beforeEach(() => {
    updateOne = jest.fn(() => ({
      exec: jest.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 1 }),
    }));
    find = jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    }));
    queueFindOne = jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(null),
    }));

    const model = {
      updateOne,
      find,
    } as unknown as Model<SportsCollectionStateDocument>;
    const queueModel = { findOne: queueFindOne } as any;

    service = new SportsCollectionStateService(model, queueModel);
  });

  it('increments dataRevision without also setting it on insert after successful collection', async () => {
    const input = {
      collectionType: 'LEAGUE_CATALOGUE',
      scopeType: 'GLOBAL' as const,
      scopeId: 'ESPN_SOCCER',
      endpoint: '/leagues',
      intervalMs: 60_000,
    };

    await service.markSucceeded(input);

    const update = updateOne.mock.calls[0][1] as {
      $setOnInsert?: Record<string, unknown>;
      $inc?: Record<string, number>;
      $unset?: Record<string, number>;
    };

    expect(update.$inc).toEqual({ dataRevision: 1 });
    expect(update.$unset).toHaveProperty('resultSummary');
    expect(update.$setOnInsert).not.toHaveProperty('dataRevision');
  });

  it('records an expected no-odds result without marking a failure or changing dataRevision', async () => {
    const input = {
      collectionType: 'MATCH_ODDS',
      scopeType: 'FIXTURE' as const,
      scopeId: 'fixture-1',
      endpoint: '/leagues/eng.1/events/event-1/odds',
      intervalMs: 0,
    };

    await service.markNoData(
      input,
      'ESPN Core and Summary returned no bookmaker prices.',
    );

    const update = updateOne.mock.calls[0][1] as {
      $set?: Record<string, any>;
      $setOnInsert?: Record<string, unknown>;
      $inc?: Record<string, number>;
      $unset?: Record<string, number>;
    };

    expect(update.$set?.status).toBe('NO_DATA');
    expect(update.$set?.failureCount).toBe(0);
    expect(update.$set?.resultSummary).toMatchObject({
      outcome: 'NO_ODDS_AVAILABLE',
      reason: 'ESPN Core and Summary returned no bookmaker prices.',
    });
    expect(update.$inc).toBeUndefined();
    expect(update.$unset).toHaveProperty('lastError');
  });

  it('recovers an abandoned stale state only when its queue job has no live lease', async () => {
    find.mockImplementationOnce(() => ({
      select: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([
        {
          collectionKey: 'MATCH_PLAYS:FIXTURE:fixture-1',
          collectionType: 'MATCH_PLAYS',
          scopeId: 'fixture-1',
          lastStartedAt: new Date(Date.now() - 30 * 60_000),
        },
      ]),
    }));

    await expect(service.recoverStaleProcessing()).resolves.toBe(1);
    expect(queueFindOne).toHaveBeenCalledWith(expect.objectContaining({
      type: 'MATCH_PLAYS_COLLECTION',
      'scope.fixtureId': 'fixture-1',
      status: 'PROCESSING',
    }));
    expect(updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'PROCESSING' }),
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'FAILED' }),
        $inc: { failureCount: 1 },
      }),
    );
  });

  it('does not recover a stale-looking state while its queue job still owns a live lease', async () => {
    find.mockImplementationOnce(() => ({
      select: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([
        {
          collectionKey: 'MATCH_PLAYS:FIXTURE:fixture-1',
          collectionType: 'MATCH_PLAYS',
          scopeId: 'fixture-1',
          lastStartedAt: new Date(Date.now() - 30 * 60_000),
        },
      ]),
    }));
    queueFindOne.mockImplementationOnce(() => ({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue({ jobKey: 'active-job' }),
    }));

    await expect(service.recoverStaleProcessing()).resolves.toBe(0);
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('increments dataRevision without also setting it on insert during fixture-day validation', async () => {
    const input = {
      competitionId: 'competition-1',
      seasonId: 'season-1',
      leagueId: 'league-1',
      date: '2026-11-07',
      endpoint: '/scoreboard?dates=20261107',
      result: 'FIXTURES_FOUND' as SportsFixtureValidationResult,
      receivedCount: 4,
      persistedCount: 4,
      missingCount: 0,
    };

    await service.recordFixtureDayValidation(input);

    const update = updateOne.mock.calls[0][1] as {
      $setOnInsert?: Record<string, unknown>;
      $inc?: Record<string, number>;
    };

    expect(update.$inc).toEqual({ dataRevision: 1 });
    expect(update.$setOnInsert).toEqual({ failureCount: 0 });
    expect(update.$setOnInsert).not.toHaveProperty('dataRevision');
  });
});

