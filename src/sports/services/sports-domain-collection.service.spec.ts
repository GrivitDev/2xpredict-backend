import { SportsDomainCollectionService } from './sports-domain-collection.service';

describe('SportsDomainCollectionService settlement evidence gates', () => {
  const now = new Date('2026-11-10T12:00:00.000Z');
  let state: { getState: jest.Mock };
  let service: SportsDomainCollectionService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    state = { getState: jest.fn() };
    service = new SportsDomainCollectionService(
      {} as any,
      {} as any,
      state as any,
      {} as any,
    );
  });

  afterEach(() => jest.useRealTimers());

  it('allows Summary collection when there is no prior collection state', async () => {
    state.getState.mockResolvedValue(null);
    await expect(service.shouldCollectFixtureSummary('espn-1')).resolves.toBe(true);
  });

  it('does not request another Summary while the last successful snapshot is fresh', async () => {
    state.getState.mockResolvedValue({
      status: 'SUCCEEDED',
      lastSuccessfulAt: new Date(now.getTime() - 10 * 60_000),
    });
    await expect(service.shouldCollectFixtureSummary('espn-1', 20 * 60_000)).resolves.toBe(false);
  });

  it('allows Summary refresh after its freshness window expires', async () => {
    state.getState.mockResolvedValue({
      status: 'SUCCEEDED',
      lastSuccessfulAt: new Date(now.getTime() - 25 * 60_000),
    });
    await expect(service.shouldCollectFixtureSummary('espn-1', 20 * 60_000)).resolves.toBe(true);
  });

  it('respects the cooldown for an active or recently failed Summary request', async () => {
    state.getState
      .mockResolvedValueOnce({
        status: 'PROCESSING',
        lastStartedAt: new Date(now.getTime() - 60_000),
      })
      .mockResolvedValueOnce({
        status: 'FAILED',
        updatedAt: new Date(now.getTime() - 60_000),
      });
    await expect(service.shouldCollectFixtureSummary('espn-1')).resolves.toBe(false);
    await expect(service.shouldCollectFixtureSummary('espn-1')).resolves.toBe(false);
  });

  it('recognizes only a successful Core Plays endpoint as complete timeline coverage', async () => {
    state.getState
      .mockResolvedValueOnce({ status: 'SUCCEEDED', endpoint: '/leagues/eng.1/events/espn-1/competitions/1/plays' })
      .mockResolvedValueOnce({ status: 'SUCCEEDED', endpoint: '/summary?event=espn-1#plays' });
    await expect(service.hasCompleteMatchPlays('fixture-1')).resolves.toBe(true);
    await expect(service.hasCompleteMatchPlays('fixture-1')).resolves.toBe(false);
  });

  it('does not re-request successful Core Plays coverage', async () => {
    state.getState.mockResolvedValue({
      status: 'SUCCEEDED',
      endpoint: '/leagues/eng.1/events/espn-1/competitions/1/plays',
    });
    await expect(service.shouldCollectMatchPlays('fixture-1')).resolves.toBe(false);
  });

  it('suppresses another Plays request during the no-data cooldown', async () => {
    state.getState.mockResolvedValue({
      status: 'NO_DATA',
      updatedAt: new Date(now.getTime() - 5 * 60_000),
    });
    await expect(service.shouldCollectMatchPlays('fixture-1')).resolves.toBe(false);
  });

  it('allows a no-data Plays checkpoint to retry after the 30-minute cooldown', async () => {
    state.getState.mockResolvedValue({
      status: 'NO_DATA',
      updatedAt: new Date(now.getTime() - 31 * 60_000),
    });
    await expect(service.shouldCollectMatchPlays('fixture-1')).resolves.toBe(true);
  });

  it('allows a Summary-only Plays fallback to be retried after the 30-minute cooldown', async () => {
    state.getState
      .mockResolvedValueOnce({
        status: 'SUCCEEDED',
        endpoint: '/summary?event=espn-1#plays',
        lastSuccessfulAt: new Date(now.getTime() - 31 * 60_000),
      })
      .mockResolvedValueOnce({
        status: 'SUCCEEDED',
        endpoint: '/summary?event=espn-1#plays',
        lastSuccessfulAt: new Date(now.getTime() - 60_000),
      });
    await expect(service.shouldCollectMatchPlays('fixture-1')).resolves.toBe(true);
    await expect(service.shouldCollectMatchPlays('fixture-1')).resolves.toBe(false);
  });
});

