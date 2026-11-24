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



describe('YoutubeService fixture-aware highlight matching', () => {
  afterEach(() => jest.useRealTimers());

  const kickoff = new Date('2026-11-16T18:00:00.000Z');

  function makeSearchService(items: any[]) {
    const service = Object.create(YoutubeService.prototype) as any;
    service.enabled = true;
    service.apiKey = 'test-api-key';
    service.channelIdByHandle = new Map();
    service.logger = { warn: jest.fn(), debug: jest.fn(), log: jest.fn(), error: jest.fn() };
    service.searchVideos = jest.fn().mockResolvedValue({ items });
    return service;
  }

  it('uses the competition name as context and records concise rejection diagnostics', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-19T10:00:00.000Z'));
    const service = makeSearchService([
      {
        id: { kind: 'youtube#video', videoId: 'pre-kickoff' },
        snippet: {
          title: 'Liverpool vs Chelsea | Match Highlights',
          description: 'Premier League',
          publishedAt: '2026-11-16T17:59:59.000Z',
          channelTitle: 'Premier League',
        },
      },
      {
        id: { kind: 'youtube#video', videoId: 'valid' },
        snippet: {
          title: 'Liverpool vs Chelsea | Extended Highlights',
          description: 'Premier League match recap.',
          publishedAt: '2026-11-18T19:00:00.000Z',
          channelTitle: 'Premier League',
        },
      },
    ]);

    const result = await service.findHighlightWithDiagnostics(
      'Liverpool',
      'Chelsea',
      kickoff,
      undefined,
      'Premier League',
    );

    expect(result.video?.videoId).toBe('valid');
    expect(result.diagnostics.videoCandidates).toBe(2);
    expect(result.diagnostics.acceptedCandidates).toBe(1);
    expect(result.diagnostics.rejected.publishedBeforeKickoff).toBe(1);
    expect(service.searchVideos).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'Liverpool Chelsea' }),
    );
  });

  it('rejects a full-match replay but keeps full-match highlights eligible', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-19T10:00:00.000Z'));
    const replayService = makeSearchService([
      {
        id: { kind: 'youtube#video', videoId: 'full-replay' },
        snippet: {
          title: 'Liverpool vs Chelsea | Full Match Replay',
          description: 'Premier League match.',
          publishedAt: '2026-11-18T19:00:00.000Z',
          channelTitle: 'Sky Sports Football',
        },
      },
    ]);
    const highlightsService = makeSearchService([
      {
        id: { kind: 'youtube#video', videoId: 'full-match-highlights' },
        snippet: {
          title: 'Liverpool vs Chelsea | Full Match Highlights',
          description: 'Premier League goals.',
          publishedAt: '2026-11-18T19:00:00.000Z',
          channelTitle: 'Sky Sports Football',
        },
      },
    ]);

    await expect(replayService.findHighlight('Liverpool', 'Chelsea', kickoff)).resolves.toBeNull();
    await expect(highlightsService.findHighlight('Liverpool', 'Chelsea', kickoff)).resolves.toEqual(
      expect.objectContaining({ videoId: 'full-match-highlights' }),
    );
  });

  it('accepts the venue-local date when it falls one day before the UTC kickoff date', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-19T10:00:00.000Z'));
    const service = makeSearchService([
      {
        id: { kind: 'youtube#video', videoId: 'venue-local-date' },
        snippet: {
          title: 'Liverpool vs Chelsea | 15 November 2026 | Match Highlights',
          description: 'Premier League goals.',
          publishedAt: '2026-11-18T19:00:00.000Z',
          channelTitle: 'Sky Sports Football',
        },
      },
    ]);

    const result = await service.findHighlightWithDiagnostics(
      'Liverpool',
      'Chelsea',
      kickoff,
      undefined,
      'Premier League',
    );

    expect(result.video?.videoId).toBe('venue-local-date');
  });

  it('rejects an older meeting when the title explicitly names a different match date', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-19T10:00:00.000Z'));
    const service = makeSearchService([
      {
        id: { kind: 'youtube#video', videoId: 'older-meeting' },
        snippet: {
          title: 'Liverpool vs Chelsea | 12 November 2026 | Match Highlights',
          description: 'Premier League goals.',
          publishedAt: '2026-11-18T19:00:00.000Z',
          channelTitle: 'Sky Sports Football',
        },
      },
    ]);

    const result = await service.findHighlightWithDiagnostics(
      'Liverpool',
      'Chelsea',
      kickoff,
      undefined,
      'Premier League',
    );

    expect(result.video).toBeNull();
    expect(result.diagnostics.rejected.contradictoryMatchDate).toBe(1);
  });

  it('allows a player-focused highlight from a configured official channel when one club and competition identify the fixture', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-19T10:00:00.000Z'));
    const service = makeSearchService([
      {
        id: { kind: 'youtube#video', videoId: 'trusted-player-clip' },
        snippet: {
          channelId: 'UC-premier-league',
          channelTitle: 'Premier League',
          title: "Salah's brace | Match Highlights",
          description: 'Liverpool match action from the Premier League.',
          publishedAt: '2026-11-18T19:00:00.000Z',
        },
      },
    ]);

    const result = await service.findHighlightWithDiagnostics(
      'Liverpool',
      'Chelsea',
      kickoff,
      'UC-premier-league',
      'Premier League',
    );

    expect(result.video?.videoId).toBe('trusted-player-clip');
    expect(result.diagnostics.acceptedCandidates).toBe(1);
  });

  it('records when a configured channel handle cannot be resolved', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-19T10:00:00.000Z'));
    const service = makeSearchService([]);
    service.resolveChannelId = jest.fn().mockResolvedValue(undefined);

    const result = await service.findHighlightWithDiagnostics(
      'Liverpool',
      'Chelsea',
      kickoff,
      '@unresolved-channel',
      'Premier League',
    );

    expect(result.video).toBeNull();
    expect(result.diagnostics.channelResolutionFailed).toBe(true);
    expect(service.searchVideos).not.toHaveBeenCalled();
  });

  it('ranks fixture-date-specific results above otherwise similar same-team highlights', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-19T10:00:00.000Z'));
    const service = makeSearchService([
      {
        id: { kind: 'youtube#video', videoId: 'generic' },
        snippet: {
          title: 'Liverpool vs Chelsea | Match Highlights',
          description: 'Premier League goals.',
          publishedAt: '2026-11-18T19:00:00.000Z',
          channelTitle: 'Sky Sports Football',
        },
      },
      {
        id: { kind: 'youtube#video', videoId: 'date-specific' },
        snippet: {
          title: 'Liverpool vs Chelsea | 16 November 2026 | Match Highlights',
          description: 'Premier League goals.',
          publishedAt: '2026-11-18T18:00:00.000Z',
          channelTitle: 'Sky Sports Football',
        },
      },
    ]);

    const result = await service.findHighlightWithDiagnostics(
      'Liverpool',
      'Chelsea',
      kickoff,
      undefined,
      'Premier League',
    );

    expect(result.video?.videoId).toBe('date-specific');
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



describe('YoutubeService endpoint-specific quota exhaustion', () => {
  function createQuotaError() {
    const error: any = new Error('YouTube quota exceeded');
    error.isAxiosError = true;
    error.response = {
      data: { error: { errors: [{ reason: 'quotaExceeded' }] } },
    };
    return error;
  }

  function createRequestService() {
    const service = Object.create(YoutubeService.prototype) as any;
    service.http = { get: jest.fn().mockRejectedValue(createQuotaError()) };
    service.logger = { error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
    service.providerRateLimitService = {
      execute: jest.fn((_provider: string, _endpoint: string, operation: () => Promise<unknown>) => operation()),
      markDailyQuotaExhausted: jest.fn().mockResolvedValue(undefined),
      markProviderDailyQuotaBlocked: jest.fn().mockResolvedValue(undefined),
    };
    return service;
  }

  it('marks only the reserved search allowance as exhausted for search.list', async () => {
    const service = createRequestService();

    await expect(service.request('/search', 'search', {})).rejects.toMatchObject({
      name: 'SportsProviderQuotaExceededError',
      period: 'daily',
    });

    expect(service.providerRateLimitService.markDailyQuotaExhausted).toHaveBeenCalledWith('youtube');
    expect(service.providerRateLimitService.markProviderDailyQuotaBlocked).not.toHaveBeenCalled();
  });

  it('blocks the provider lane for channels.list without consuming search.list allowance', async () => {
    const service = createRequestService();

    await expect(service.request('/channels', 'channel-lookup', {})).rejects.toMatchObject({
      name: 'SportsProviderQuotaExceededError',
      period: 'daily',
    });

    expect(service.providerRateLimitService.markProviderDailyQuotaBlocked).toHaveBeenCalledWith('youtube');
    expect(service.providerRateLimitService.markDailyQuotaExhausted).not.toHaveBeenCalled();
  });
});
