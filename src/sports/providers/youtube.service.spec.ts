import { YoutubeService } from './youtube.service';

describe('YoutubeService channel lookup quota accounting', () => {
  it('does not consume the reserved daily search allowance for channels.list', async () => {
    const service = Object.create(YoutubeService.prototype) as any;
    service.channelIdByHandle = new Map();
    service.logger = { debug: jest.fn(), warn: jest.fn() };
    service.request = jest.fn().mockResolvedValue({
      items: [{ id: 'UCarsenal-channel' }],
    });

    await expect(service.resolveChannelId('@arsenal')).resolves.toBe(
      'UCarsenal-channel',
    );
    expect(service.request).toHaveBeenCalledWith(
      '/channels',
      'channel-lookup',
      expect.objectContaining({ forHandle: '@arsenal' }),
      { countTowardProviderQuota: false, minimumIntervalSeconds: 1 },
    );
  });
});

describe('YoutubeService highlight candidate matching', () => {
  const kickoff = new Date('2026-11-16T18:00:00.000Z');

  function makeService(candidate: Record<string, unknown>) {
    const service = Object.create(YoutubeService.prototype) as any;
    service.enabled = true;
    service.logger = { warn: jest.fn(), debug: jest.fn(), log: jest.fn(), error: jest.fn() };
    service.searchVideos = jest.fn().mockResolvedValue({
      items: [
        {
          id: { kind: 'youtube#video', videoId: 'video-1' },
          snippet: candidate,
        },
      ],
    });
    return service;
  }

  it('accepts a player-focused title when the description identifies both teams and the video is clearly a highlight', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-19T10:00:00.000Z'));
    const service = makeService({
      title: "Mohamed Salah's brace against Chelsea | Match Highlights",
      description: 'Liverpool vs Chelsea. Premier League match highlights and all goals.',
      channelTitle: 'Sky Sports Football',
      publishedAt: '2026-11-18T19:00:00.000Z',
    });

    const result = await service.findHighlight('Liverpool', 'Chelsea', kickoff);

    expect(result?.videoId).toBe('video-1');
    expect(service.searchVideos).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'Liverpool Chelsea',
        order: 'relevance',
        maxResults: 25,
        publishedAfter: kickoff.toISOString(),
      }),
    );
    expect(service.searchVideos.mock.calls[0][0]).not.toHaveProperty('publishedBefore');
  });

  it('accepts videos published more than 24 hours after kickoff', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-19T10:00:00.000Z'));
    const service = makeService({
      title: 'Liverpool vs Chelsea | Extended Highlights',
      description: 'Premier League match highlights and goals.',
      channelTitle: 'Premier League',
      publishedAt: '2026-11-18T19:00:00.000Z',
    });

    await expect(
      service.findHighlight('Liverpool', 'Chelsea', kickoff),
    ).resolves.toEqual(
      expect.objectContaining({ videoId: 'video-1' }),
    );
  });

  it('never accepts a video published before kickoff', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-19T10:00:00.000Z'));
    const service = makeService({
      title: 'Liverpool vs Chelsea | Match Preview and Highlights',
      description: 'Liverpool and Chelsea match highlights.',
      channelTitle: 'Football Channel',
      publishedAt: '2026-11-16T17:59:59.000Z',
    });

    await expect(
      service.findHighlight('Liverpool', 'Chelsea', kickoff),
    ).resolves.toBeNull();
  });

  it('rejects interviews even when both team names are present', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-19T10:00:00.000Z'));
    const service = makeService({
      title: 'Mohamed Salah post-match interview',
      description: 'Liverpool vs Chelsea. Match highlights and goals.',
      channelTitle: 'Liverpool FC',
      publishedAt: '2026-11-18T19:00:00.000Z',
    });

    await expect(
      service.findHighlight('Liverpool', 'Chelsea', kickoff),
    ).resolves.toBeNull();
  });
});


describe('YoutubeService search request filters', () => {
  it('requires embeddability without excluding non-syndicated videos', async () => {
    const service = Object.create(YoutubeService.prototype) as any;
    service.enabled = true;
    service.apiKey = 'test-api-key';
    service.request = jest.fn().mockResolvedValue({ items: [] });

    await service.searchVideos({ query: 'Liverpool Chelsea', maxResults: 25 });

    expect(service.request).toHaveBeenCalledWith(
      '/search',
      'search',
      expect.objectContaining({
        videoEmbeddable: 'true',
        maxResults: 25,
      }),
    );
    expect(service.request.mock.calls[0][2]).not.toHaveProperty('videoSyndicated');
  });
});
