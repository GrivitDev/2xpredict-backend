import {
  isSportsFixtureFinished,
  isSportsFixtureInProgress,
  isSportsFixtureSettleable,
} from './fixture-lifecycle.util';

const fixture = (state: string, isFinal = false) =>
  ({ status: { state, isFinal } }) as any;

describe('Sports settlement fixture lifecycle', () => {
  it.each(['SCHEDULED', 'POSTPONED', 'CANCELLED', 'ABANDONED', 'UNKNOWN'])(
    'does not settle %s fixtures',
    (state) => {
      const value = fixture(state, true);
      expect(isSportsFixtureSettleable(value)).toBe(false);
      expect(isSportsFixtureFinished(value)).toBe(false);
      expect(isSportsFixtureInProgress(value)).toBe(false);
    },
  );

  it.each(['LIVE', 'HALFTIME', 'EXTRA_TIME', 'PENALTIES'])(
    'recognises %s as in progress and settleable for eligible live markets',
    (state) => {
      const value = fixture(state);
      expect(isSportsFixtureSettleable(value)).toBe(true);
      expect(isSportsFixtureInProgress(value)).toBe(true);
      expect(isSportsFixtureFinished(value)).toBe(false);
    },
  );

  it('recognises completed fixtures as finished and settleable', () => {
    const value = fixture('COMPLETED', true);
    expect(isSportsFixtureSettleable(value)).toBe(true);
    expect(isSportsFixtureFinished(value)).toBe(true);
    expect(isSportsFixtureInProgress(value)).toBe(false);
  });

  it('fails closed for missing fixture status', () => {
    expect(isSportsFixtureSettleable(undefined)).toBe(false);
    expect(isSportsFixtureFinished(null)).toBe(false);
    expect(isSportsFixtureInProgress({} as any)).toBe(false);
  });
});
