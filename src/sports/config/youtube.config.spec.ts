import {
  getYoutubeLeaguePriority,
  YOUTUBE_CONFIG,
  YOUTUBE_LEAGUE_GROUPS,
} from './youtube.config';

describe('YouTube highlight league ranking', () => {
  it('contains exactly 24 unique leagues arranged in four groups of six', () => {
    const groups = Object.values(YOUTUBE_LEAGUE_GROUPS);
    const allSlugs = groups.flat();

    expect(groups).toHaveLength(4);
    expect(groups.every((group) => group.length === 6)).toBe(true);
    expect(allSlugs).toHaveLength(24);
    expect(new Set(allSlugs).size).toBe(24);
    expect(YOUTUBE_CONFIG.supportedCompetitionSlugs).toHaveLength(24);
  });

  it('assigns descending priority to each group', () => {
    expect(getYoutubeLeaguePriority('eng.1')).toBe(40);
    expect(getYoutubeLeaguePriority('usa.1')).toBe(30);
    expect(getYoutubeLeaguePriority('arg.1')).toBe(20);
    expect(getYoutubeLeaguePriority('gre.1')).toBe(10);
    expect(getYoutubeLeaguePriority('unknown.league')).toBe(1);
  });
});
