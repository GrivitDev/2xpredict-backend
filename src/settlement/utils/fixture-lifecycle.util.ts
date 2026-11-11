import type { SportsFixtureRecord, SportsFixtureState } from '../../sports/interfaces/sports-domain.interface';

const NON_SETTLEABLE = new Set<SportsFixtureState>([
  'SCHEDULED',
  'POSTPONED',
  'CANCELLED',
  'ABANDONED',
  'UNKNOWN',
]);

/** Lifecycle comes only from the normalized Sports fixture, never kickoff age. */
export function isSportsFixtureSettleable(value: SportsFixtureRecord | null | undefined): boolean {
  if (!value?.status) return false;
  const state = value.status.state;
  if (NON_SETTLEABLE.has(state)) return false;
  return value.status.isFinal === true || [
    'LIVE', 'HALFTIME', 'EXTRA_TIME', 'PENALTIES', 'COMPLETED',
  ].includes(state);
}

export function isSportsFixtureFinished(value: SportsFixtureRecord | null | undefined): boolean {
  if (!value?.status) return false;
  if (NON_SETTLEABLE.has(value.status.state)) return false;
  return value.status.state === 'COMPLETED' || value.status.isFinal === true;
}

export function isSportsFixtureInProgress(value: SportsFixtureRecord | null | undefined): boolean {
  if (!value?.status || isSportsFixtureFinished(value)) return false;
  return ['LIVE', 'HALFTIME', 'EXTRA_TIME', 'PENALTIES'].includes(value.status.state);
}
