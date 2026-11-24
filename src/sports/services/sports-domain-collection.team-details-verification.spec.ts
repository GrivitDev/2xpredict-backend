import { SportsDomainCollectionService } from './sports-domain-collection.service';

function createHarness(result: any) {
  const provider = { collectTeamDetails: jest.fn().mockResolvedValue(result) };
  const persistence = { saveTeams: jest.fn().mockResolvedValue(1) };
  const state = {
    markStarted: jest.fn().mockResolvedValue(undefined),
    markSucceeded: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
  };
  const service = Object.create(SportsDomainCollectionService.prototype) as any;
  Object.assign(service, { provider, persistence, state });
  return { service, provider, persistence, state };
}

const team = (espnId: string) => ({
  id: `team:${espnId}`,
  espnId,
  leagueIds: ['eng.1'],
  name: `Team ${espnId}`,
  source: {
    provider: 'ESPN' as const,
    endpoint: `/leagues/eng.1/teams/${espnId}`,
    providerId: espnId,
    collectedAt: new Date('2026-11-24T10:00:00.000Z'),
  },
  createdAt: new Date('2026-11-24T10:00:00.000Z'),
  updatedAt: new Date('2026-11-24T10:00:00.000Z'),
});

describe('SportsDomainCollectionService team-detail response verification', () => {
  it('rejects a successful-looking provider response for a different team ID', async () => {
    const harness = createHarness(team('999'));

    await expect(
      harness.service.collectTeamDetails('eng.1', '114'),
    ).rejects.toThrow(/team identity mismatch/i);

    expect(harness.persistence.saveTeams).not.toHaveBeenCalled();
    expect(harness.state.markSucceeded).not.toHaveBeenCalled();
    expect(harness.state.markFailed).toHaveBeenCalledTimes(1);
  });

  it('persists and marks success only when the provider response matches the requested team', async () => {
    const expected = team('114');
    const harness = createHarness(expected);

    await expect(
      harness.service.collectTeamDetails('eng.1', '114'),
    ).resolves.toBe(expected);

    expect(harness.persistence.saveTeams).toHaveBeenCalledWith([expected]);
    expect(harness.state.markSucceeded).toHaveBeenCalledTimes(1);
    expect(harness.state.markFailed).not.toHaveBeenCalled();
  });

  it('accepts canonical team IDs in the queue scope', async () => {
    const expected = team('114');
    const harness = createHarness(expected);

    await expect(
      harness.service.collectTeamDetails('eng.1', 'team:114'),
    ).resolves.toBe(expected);

    expect(harness.persistence.saveTeams).toHaveBeenCalledWith([expected]);
  });
});

