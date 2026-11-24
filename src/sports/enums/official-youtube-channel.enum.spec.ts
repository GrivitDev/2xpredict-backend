import {
  getYoutubeHighlightSearchPlan,
  OfficialYoutubeChannel,
} from './official-youtube-channel.enum';

describe('YouTube highlight channel search plans', () => {
  it('checks the competition and both club channels before unrestricted search', () => {
    const plan = getYoutubeHighlightSearchPlan('eng.1', 'Arsenal', 'Chelsea');

    expect(plan).toEqual([
      OfficialYoutubeChannel.PREMIER_LEAGUE,
      OfficialYoutubeChannel.ARSENAL,
      OfficialYoutubeChannel.CHELSEA,
      null,
    ]);
  });

  it('keeps club channels and a broad source available when no league channel is configured', () => {
    const plan = getYoutubeHighlightSearchPlan(
      'unsupported.test.league',
      'Arsenal',
      'Chelsea',
    );

    expect(plan).toContain(OfficialYoutubeChannel.ARSENAL);
    expect(plan).toContain(OfficialYoutubeChannel.CHELSEA);
    expect(plan).toContain(OfficialYoutubeChannel.SPORTY_TV);
    expect(plan[plan.length - 1]).toBeNull();
    expect(new Set(plan.filter(Boolean)).size).toBe(plan.filter(Boolean).length);
  });
});


