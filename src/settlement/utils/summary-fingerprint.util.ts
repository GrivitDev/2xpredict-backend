import { createHash } from 'node:crypto';

type RecordLike = Record<string, unknown>;
const asString = (value: unknown): string =>
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'boolean' ||
  typeof value === 'bigint' ||
  typeof value === 'symbol'
    ? String(value)
    : '';
const asRecord = (value: unknown): RecordLike =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordLike)
    : {};
const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const record = value as RecordLike;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, stable(record[key])]),
    );
  }
  return value;
};

/**
 * Stable settlement idempotency fingerprint. Includes Summary content and the
 * official fixture-level result/status so a score/status correction can be
 * reprocessed even when ESPN leaves the Summary hash unchanged.
 */
export function createSettlementSourceFingerprint(
  fixtureValue: unknown,
): string {
  const fixture = asRecord(fixtureValue);
  const payload = asRecord(fixture.payload);
  const summary = asRecord(payload.summary);
  const summaryHash = asString(payload.summaryContentHash).trim();
  const competitions = asArray(payload.competitions).map((value) => {
    const competition = asRecord(value);
    const status = asRecord(competition.status);
    const statusType = asRecord(status.type);
    return {
      id: competition.id,
      status: {
        completed: statusType.completed,
        state: statusType.state,
        name: statusType.name,
        description: statusType.description,
      },
      competitors: asArray(competition.competitors).map((item) => {
        const competitor = asRecord(item);
        return {
          id: competitor.id,
          homeAway: competitor.homeAway,
          score: competitor.score,
        };
      }),
    };
  });
  const identity = {
    eventId: asString(fixture.eventId ?? payload.id),
    leagueId: asString(fixture.leagueId),
    // Keep the full normalized Summary in the fingerprint even when ESPN sends
    // summaryContentHash. Provider hashes can be stale or unchanged after a
    // partial update; the actual settled facts must still invalidate old runs.
    summaryHash,
    summary: stable(summary),
    completed: fixture.completed,
    live: fixture.live,
    status: fixture.status,
    statusDetail: fixture.statusDetail,
    homeScore: fixture.homeScore,
    awayScore: fixture.awayScore,
    competitions,
  };
  return createHash('sha256')
    .update(JSON.stringify(stable(identity)))
    .digest('hex');
}


