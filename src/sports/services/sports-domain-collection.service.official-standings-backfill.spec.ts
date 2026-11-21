import { SportsDomainCollectionService } from './sports-domain-collection.service';

function query<T>(value: T) {
  const q: any = {};
  q.select = jest.fn(() => q);
  q.lean = jest.fn(() => q);
  q.exec = jest.fn().mockResolvedValue(value);
  return q;
}

describe('SportsDomainCollectionService official standings local backfill', () => {
  it('extracts official standings from a retained Summary without rewriting Match Facts', async () => {
    const snapshot = { competitionId: 'competition-1', seasonId: 'season-1' };
    const summaryQuery = query({
      endpoint: '/summary?event=event-1',
      payloadHash: 'summary-hash',
      revision: 3,
      lastCollectedAt: new Date('2026-11-19T12:00:00.000Z'),
      rawPayload: { standings: { groups: [{ standings: { entries: [{ id: '1' }] } }] } },
    });
    const service = Object.create(SportsDomainCollectionService.prototype) as any;
    service.persistence = {
      getMatchSummaryByFixtureId: jest.fn(() => summaryQuery.exec()),
      saveOfficialStandings: jest.fn().mockResolvedValue({ saved: true, reason: 'SAVED' }),
    };
    service.matchFactsNormalization = {
      normalizeOfficialStandings: jest.fn().mockReturnValue(snapshot),
      normalizeAndPersist: jest.fn(),
    };
    service.logger = { warn: jest.fn() };

    const saved = await service.normalizeStoredOfficialStandings({
      id: 'fixture-1',
      espnEventId: 'event-1',
      competitionId: 'competition-1',
      seasonId: 'season-1',
      kickoffAt: new Date('2026-11-18T12:00:00.000Z'),
    });

    expect(saved).toBe(true);
    expect(service.matchFactsNormalization.normalizeOfficialStandings).toHaveBeenCalledWith(
      expect.objectContaining({ competitionId: 'competition-1', seasonId: 'season-1' }),
    );
    expect(service.matchFactsNormalization.normalizeAndPersist).not.toHaveBeenCalled();
    expect(service.persistence.saveOfficialStandings).toHaveBeenCalledWith(snapshot);
  });

  it('does not call persistence when the retained Summary has no standings section', async () => {
    const summaryQuery = query({ rawPayload: { header: {} } });
    const service = Object.create(SportsDomainCollectionService.prototype) as any;
    service.persistence = {
      getMatchSummaryByFixtureId: jest.fn(() => summaryQuery.exec()),
      saveOfficialStandings: jest.fn(),
    };
    service.matchFactsNormalization = {
      normalizeOfficialStandings: jest.fn().mockReturnValue(null),
    };
    service.logger = { warn: jest.fn() };

    await expect(service.normalizeStoredOfficialStandings({
      id: 'fixture-1', competitionId: 'competition-1', seasonId: 'season-1',
      kickoffAt: new Date('2026-11-18T12:00:00.000Z'),
    } as any)).resolves.toBe(false);
    expect(service.persistence.saveOfficialStandings).not.toHaveBeenCalled();
  });
});
