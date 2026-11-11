import { EspnV2Client } from './espn-v2.client';

describe('EspnV2Client Core Plays source fallback', () => {
  it('falls back to the unfiltered Plays collection when source 38 is empty', async () => {
    const client = Object.create(EspnV2Client.prototype) as EspnV2Client;
    const collectionSpy = jest
      .spyOn(client as any, 'getPagedCollection')
      .mockResolvedValueOnce({
        items: [],
        pageCount: 1,
        totalCount: 0,
        endpoint: '/plays?source=38',
        rawResponse: { count: 0, items: [] },
      })
      .mockResolvedValueOnce({
        items: [{ id: 'play-1' }],
        pageCount: 1,
        totalCount: 1,
        endpoint: '/plays',
        rawResponse: { count: 1, items: [{ id: 'play-1' }] },
      });
    jest.spyOn(client as any, 'matchCompetitionPath').mockReturnValue('/events/event-1/competitions/event-1');
    jest.spyOn(client as any, 'resolveCollectionReferencesStrict').mockResolvedValue([
      { id: 'play-1' },
    ]);

    const result = await client.getMatchPlays('eng.1', 'event-1', 'event-1');

    expect(collectionSpy).toHaveBeenNthCalledWith(
      1,
      '/events/event-1/competitions/event-1/plays',
      'match-plays-source-38',
      { source: '38' },
      100,
    );
    expect(collectionSpy).toHaveBeenNthCalledWith(
      2,
      '/events/event-1/competitions/event-1/plays',
      'match-plays-all-sources',
      {},
      100,
    );
    expect(result.items).toHaveLength(1);
    expect(result.rawResponse?.playsCollectionDiagnostics).toMatchObject({
      sourceFilteredCount: 0,
      selectedSource: 'ALL_SOURCES',
      sourceFallbackUsed: true,
    });
  });

  it('does not make the unfiltered request when source 38 already has plays', async () => {
    const client = Object.create(EspnV2Client.prototype) as EspnV2Client;
    const collectionSpy = jest.spyOn(client as any, 'getPagedCollection').mockResolvedValue({
      items: [{ id: 'play-1' }],
      pageCount: 1,
      totalCount: 1,
      endpoint: '/plays?source=38',
      rawResponse: { count: 1, items: [{ id: 'play-1' }] },
    });
    jest.spyOn(client as any, 'matchCompetitionPath').mockReturnValue('/events/event-1/competitions/event-1');
    jest.spyOn(client as any, 'resolveCollectionReferencesStrict').mockResolvedValue([
      { id: 'play-1' },
    ]);

    await client.getMatchPlays('eng.1', 'event-1', 'event-1');

    expect(collectionSpy).toHaveBeenCalledTimes(1);
  });
});
