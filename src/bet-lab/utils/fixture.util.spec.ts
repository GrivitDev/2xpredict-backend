import { ConflictException } from '@nestjs/common';
import type { BetLabFixtureIdentity } from '../interfaces/bet-lab-market.interface';
import { assertBetLabPreMatchFixture } from './fixture.util';

const NOW = new Date('2026-11-10T12:00:00.000Z');

function fixture(overrides: Partial<BetLabFixtureIdentity> = {}): BetLabFixtureIdentity {
  return {
    eventId: 'fixture-1',
    leagueId: 'league-1',
    leagueName: 'League',
    fixtureDate: new Date('2026-11-10T15:00:00.000Z'),
    live: false,
    completed: false,
    homeTeamId: 'home-1',
    homeTeamName: 'Home FC',
    awayTeamId: 'away-1',
    awayTeamName: 'Away FC',
    status: 'SCHEDULED',
    collectedAt: NOW,
    sportsUpdatedAt: NOW,
    payload: {},
    ...overrides,
  };
}

describe('assertBetLabPreMatchFixture', () => {
  it('accepts a future fixture explicitly marked as scheduled', () => {
    expect(() => assertBetLabPreMatchFixture(fixture(), NOW)).not.toThrow();
  });

  it('rejects a live fixture even when its stored kickoff time is still in the future', () => {
    expect(() =>
      assertBetLabPreMatchFixture(fixture({ live: true, status: 'LIVE' }), NOW),
    ).toThrow(ConflictException);
  });

  it.each(['HALFTIME', 'EXTRA_TIME', 'PENALTIES'])('rejects the %s state', (status) => {
    expect(() => assertBetLabPreMatchFixture(fixture({ status }), NOW)).toThrow(ConflictException);
  });

  it('rejects kickoff times that have been reached, even if Sports still says scheduled', () => {
    expect(() =>
      assertBetLabPreMatchFixture(
        fixture({ fixtureDate: new Date('2026-11-10T12:00:00.000Z') }),
        NOW,
      ),
    ).toThrow(/placement is closed/i);
  });

  it('rejects unknown or unrecognized fixture states instead of assuming they are pre-match', () => {
    expect(() => assertBetLabPreMatchFixture(fixture({ status: 'UNKNOWN' }), NOW)).toThrow(ConflictException);
  });

  it('rejects live provider descriptions even when the normalized state is stale', () => {
    expect(() =>
      assertBetLabPreMatchFixture(
        fixture({ statusDetail: 'First Half', statusShortDetail: '1st Half' }),
        NOW,
      ),
    ).toThrow(/pre-match fixtures only/i);
  });

  it('rejects postponed, cancelled and suspended fixtures', () => {
    for (const status of ['POSTPONED', 'CANCELLED', 'SUSPENDED']) {
      expect(() => assertBetLabPreMatchFixture(fixture({ status }), NOW)).toThrow(ConflictException);
    }
  });

  it('rejects an invalid kickoff timestamp', () => {
    expect(() =>
      assertBetLabPreMatchFixture(fixture({ fixtureDate: new Date(Number.NaN) }), NOW),
    ).toThrow(ConflictException);
  });
});
