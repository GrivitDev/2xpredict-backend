import { createHash } from 'node:crypto';
import type { SportsMatchReadModel } from '../../sports/interfaces/sports-read.interface';

type RecordLike = Record<string, unknown>;
const record = (value: unknown): RecordLike =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordLike
    : {};
const stable = (value: unknown): unknown => {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const item = value as RecordLike;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, stable(item[key])]));
  }
  return value;
};
const sourceIdentity = (value: unknown) => {
  const source = record(value);
  return {
    provider: source.provider,
    endpoint: source.endpoint,
    providerId: source.providerId,
    providerUpdatedAt: source.providerUpdatedAt,
    collectedAt: source.collectedAt,
  };
};

/**
 * Stable idempotency fingerprint over the normalized Sports facts used by
 * settlement. Any meaningful fixture, score, period, statistics or timeline
 * change creates a new job version; odds snapshots are intentionally excluded.
 */
export function createSettlementSourceFingerprint(matchValue: unknown): string {
  const match = record(matchValue) as unknown as Partial<SportsMatchReadModel>;
  const fixture = record(match.fixture);
  const competitors = Array.isArray(match.fixture?.competitors)
    ? [...match.fixture.competitors]
        .map((competitor) => ({
          ...competitor,
          // Embedded team statistics are part of the canonical fixture record.
          // Sort for deterministic fingerprints without changing their values.
          statistics: [...(competitor.statistics ?? [])].sort((left, right) => {
            const a = record(left);
            const b = record(right);
            const keyOrder = String(a.key ?? a.name ?? a.abbreviation ?? '').localeCompare(
              String(b.key ?? b.name ?? b.abbreviation ?? ''),
            );
            if (keyOrder !== 0) return keyOrder;
            return JSON.stringify(stable(left)).localeCompare(JSON.stringify(stable(right)));
          }),
        }))
        .sort((a, b) => a.homeAway.localeCompare(b.homeAway))
    : [];
  const periodScores = Array.isArray(match.fixture?.periodScores)
    ? [...match.fixture.periodScores].sort(
        (a, b) => a.teamId.localeCompare(b.teamId) || a.period - b.period,
      )
    : [];
  const timeline = (match.timeline ?? [])
    .map((item) => ({
      id: item.id,
      sequence: item.sequence,
      period: item.period,
      clock: item.clock,
      clockSeconds: item.clockSeconds,
      addedClock: item.addedClock,
      type: item.type,
      typeId: item.typeId,
      typeKey: item.typeKey,
      description: item.description,
      teamId: item.teamId,
      athleteId: item.athleteId,
      relatedAthleteId: item.relatedAthleteId,
      involvedAthletes: item.involvedAthletes,
      scoreAfter: item.scoreAfter,
      homeScore: item.homeScore,
      awayScore: item.awayScore,
      scoringPlay: item.scoringPlay,
      valid: item.valid,
      redCard: item.redCard,
      yellowCard: item.yellowCard,
      penaltyKick: item.penaltyKick,
      ownGoal: item.ownGoal,
      shootout: item.shootout,
      substitution: item.substitution,
      source: sourceIdentity(item.source),
    }))
    .sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
  const identity = {
    eventId: fixture.id ?? fixture.espnEventId,
    competitionId: fixture.competitionId,
    seasonId: fixture.seasonId,
    kickoffAt: fixture.kickoffAt,
    status: fixture.status,
    competitors,
    periodScores,
    completedAt: fixture.completedAt,
    neutralSite: fixture.neutralSite,
    fixtureSource: sourceIdentity(fixture.source),
    summaryMetadata: match.matchSummary
      ? {
          payloadHash: match.matchSummary.payloadHash,
          revision: match.matchSummary.revision,
          lastCollectedAt: match.matchSummary.lastCollectedAt,
        }
      : null,
    normalizedMatchFacts: match.matchFacts
      ? {
          sourcePayloadHash: match.matchFacts.sourcePayloadHash,
          sourceRevision: match.matchFacts.sourceRevision,
          normalizationHash: match.matchFacts.normalizationHash,
          normalizationVersion: match.matchFacts.normalizationVersion,
          sourceCollectedAt: match.matchFacts.sourceCollectedAt,
          revision: match.matchFacts.revision,
          matchResult: match.matchFacts.matchResult,
          periodScores: match.matchFacts.periodScores,
          teamStatistics: match.matchFacts.teamStatistics,
          playerAppearances: match.matchFacts.playerAppearances,
          sectionStatus: match.matchFacts.sectionStatus,
        }
      : null,
    timeline,
  };
  return createHash('sha256')
    .update(JSON.stringify(stable(identity)))
    .digest('hex');
}

