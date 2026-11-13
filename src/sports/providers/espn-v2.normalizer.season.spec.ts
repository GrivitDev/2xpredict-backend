import { EspnV2Normalizer } from './espn-v2.normalizer';

describe('EspnV2Normalizer season date ranges', () => {
  let normalizer: EspnV2Normalizer;

  beforeEach(() => {
    normalizer = new EspnV2Normalizer();
  });

  const season = {
    id: '2026',
    year: 2026,
    displayName: "2027 FIFA Women's World Cup Qualifying - Playoff Tournament",
    startDate: '2026-10-01T04:00Z',
    // ESPN's aggregate end date has the wrong year.
    endDate: '2026-03-01T04:59Z',
    type: {
      startDate: '2026-11-01T04:00Z',
      endDate: '2027-02-01T04:59Z',
    },
    types: {
      items: [
        {
          startDate: '2026-11-01T04:00Z',
          endDate: '2027-02-01T04:59Z',
        },
        {
          startDate: '2027-02-01T05:00Z',
          endDate: '2027-03-01T04:59Z',
        },
      ],
    },
  };

  it('repairs a reversed aggregate end date using the latest season phase boundary', () => {
    const normalized = normalizer.normalizeSeason(
      season,
      'competition:fifa.wwcq.ply',
      true,
    );

    expect(normalized.startDate?.toISOString()).toBe('2026-10-01T04:00:00.000Z');
    expect(normalized.endDate?.toISOString()).toBe('2027-03-01T04:59:00.000Z');
  });

  it('applies the same phase-boundary repair to competition current-season dates', () => {
    const normalized = normalizer.normalizeCompetition(
      { slug: 'fifa.wwcq.ply', season },
      'fifa.wwcq.ply',
    );

    expect(normalized.currentSeasonStartDate?.toISOString()).toBe(
      '2026-10-01T04:00:00.000Z',
    );
    expect(normalized.currentSeasonEndDate?.toISOString()).toBe(
      '2027-03-01T04:59:00.000Z',
    );
  });

  it('preserves valid aggregate dates for cross-calendar-year seasons', () => {
    const normalized = normalizer.normalizeSeason(
      {
        ...season,
        startDate: '2026-06-01T04:00Z',
        endDate: '2027-06-01T03:59Z',
      },
      'competition:eng.1',
      true,
    );

    expect(normalized.startDate?.toISOString()).toBe('2026-06-01T04:00:00.000Z');
    expect(normalized.endDate?.toISOString()).toBe('2027-06-01T03:59:00.000Z');
  });
});
