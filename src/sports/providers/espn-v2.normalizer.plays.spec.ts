import { EspnV2Normalizer } from './espn-v2.normalizer';

describe('EspnV2Normalizer timeline extraction', () => {
  let normalizer: EspnV2Normalizer;
  const context = {
    fixtureId: 'fixture-1',
    leagueId: 'eng.1',
    eventId: 'event-1',
    competitionId: 'event-1',
  };

  beforeEach(() => {
    normalizer = new EspnV2Normalizer();
  });

  it('does not let an empty items array hide populated keyEvents', () => {
    const result = normalizer.normalizeMatchTimeline(
      {
        items: [],
        keyEvents: [
          { id: 'play-1', type: { text: 'Kickoff' }, text: 'First Half begins.' },
        ],
      },
      context,
    );

    expect(result).toHaveLength(1);
    expect(result[0].espnPlayId).toBe('play-1');
  });

  it('extracts Summary keyEvents when the preferred plays array is empty', () => {
    const result = normalizer.normalizeSummaryTimeline(
      {
        plays: [],
        keyEvents: [
          { id: 'play-2', type: { text: 'Goal' }, text: 'Goal scored.' },
        ],
      },
      context,
    );

    expect(result).toHaveLength(1);
    expect(result[0].espnPlayId).toBe('play-2');
    expect(result[0].source.endpoint).toContain('#plays');
  });

  it('extracts nested event arrays from an alternate data envelope', () => {
    const result = normalizer.normalizeMatchTimeline(
      {
        items: [],
        data: { entries: [{ id: 'play-3', text: 'Second Half begins.' }] },
      },
      context,
    );

    expect(result).toHaveLength(1);
    expect(result[0].espnPlayId).toBe('play-3');
  });
});
