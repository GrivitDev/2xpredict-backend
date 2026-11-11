import { EspnV2Normalizer } from './espn-v2.normalizer';

describe('EspnV2Normalizer odds array fallback handling', () => {
  let normalizer: EspnV2Normalizer;

  const context = {
    fixtureId: 'fixture-1',
    leagueId: 'uefa.nations',
    eventId: 'event-1',
    competitionId: 'event-1',
    homeTeam: 'Türkiye',
    awayTeam: 'Belgium',
    kickoffAt: new Date('2026-11-12T17:00:00.000Z'),
    collectedAt: new Date('2026-11-10T12:00:00.000Z'),
  };

  const bookmaker = {
    provider: { id: '100', name: 'DraftKings', priority: 1 },
    awayTeamOdds: { moneyLine: -120 },
    homeTeamOdds: { moneyLine: 255 },
    drawOdds: { moneyLine: 290 },
    overUnder: 3.5,
    overOdds: 125,
    underOdds: -160,
  };

  beforeEach(() => {
    normalizer = new EspnV2Normalizer();
  });

  it('uses a populated Core odds array when the preferred items array is empty', () => {
    const snapshot = normalizer.normalizeEspnOdds(
      { count: 0, items: [], odds: [bookmaker] },
      context,
      '/leagues/uefa.nations/events/event-1/competitions/event-1/odds',
    );

    expect(snapshot).not.toBeNull();
    expect(snapshot?.bookmakers).toHaveLength(1);
    expect(snapshot?.bookmakers[0].bookmakerName).toBe('DraftKings');
    expect(snapshot?.bookmakers[0].markets).toEqual(
      expect.arrayContaining([expect.objectContaining({ marketKey: 'h2h' })]),
    );
  });

  it('uses Summary odds.value when pickcenter is present but empty', () => {
    const snapshot = normalizer.normalizeEspnSummaryOdds(
      { pickcenter: [], odds: { value: [bookmaker] }, hasOdds: false },
      context,
      '/leagues/uefa.nations/summary?event=event-1',
    );

    expect(snapshot).not.toBeNull();
    expect(snapshot?.provider).toBe('ESPN_SUMMARY');
    expect(snapshot?.bookmakers).toHaveLength(1);
    expect(snapshot?.bookmakers[0].bookmakerName).toBe('DraftKings');
  });
});
