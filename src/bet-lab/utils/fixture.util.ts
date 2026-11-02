import { BetLabFixtureIdentity } from '../interfaces/bet-lab-market.interface';

export type UnknownRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function asRecord(value: unknown): UnknownRecord | null {
  return isRecord(value) ? value : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function asDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

export function extractFixtureTeam(
  payload: UnknownRecord,
  side: 'home' | 'away',
  expectedId: string,
): { id: string; name: string; abbreviation?: string; logo?: string } {
  const competitions = asArray(payload.competitions);
  for (const competitionValue of competitions) {
    const competition = asRecord(competitionValue);
    if (!competition) continue;
    for (const competitorValue of asArray(competition.competitors)) {
      const competitor = asRecord(competitorValue);
      if (!competitor) continue;
      const team = asRecord(competitor.team);
      const competitorId =
        asNonEmptyString(competitor.id) ?? asNonEmptyString(team?.id);
      const homeAway = asNonEmptyString(competitor.homeAway)?.toLowerCase();
      if (competitorId !== expectedId && homeAway !== side) continue;
      const id = competitorId ?? expectedId;
      const name =
        asNonEmptyString(team?.displayName) ??
        asNonEmptyString(team?.name) ??
        asNonEmptyString(team?.shortDisplayName) ??
        (side === 'home' ? 'Home Team' : 'Away Team');
      return {
        id,
        name,
        abbreviation: asNonEmptyString(team?.abbreviation) ?? undefined,
        logo: asNonEmptyString(team?.logo) ?? undefined,
      };
    }
  }
  return {
    id: expectedId,
    name: side === 'home' ? 'Home Team' : 'Away Team',
  };
}

export function extractFixtureIdentity(fixture: {
  eventId: string;
  leagueId: string;
  fixtureDate: Date;
  live: boolean;
  completed?: boolean;
  status: string;
  homeTeamId: string;
  awayTeamId: string;
  collectedAt: Date;
  payload: unknown;
}): BetLabFixtureIdentity {
  const payload = asRecord(fixture.payload) ?? {};
  const home = extractFixtureTeam(payload, 'home', String(fixture.homeTeamId));
  const away = extractFixtureTeam(payload, 'away', String(fixture.awayTeamId));
  const competitions = asArray(payload.competitions);
  const competition = asRecord(competitions[0]);
  const venue = asRecord(competition?.venue) ?? asRecord(payload.venue);
  const summary = asRecord(payload.summary);
  const summaryCollectedAt =
    asDate(payload.summaryCollectedAt) ?? fixture.collectedAt;
  return {
    eventId: String(fixture.eventId),
    leagueId: String(fixture.leagueId),
    leagueName:
      asNonEmptyString(competition?.name) ??
      asNonEmptyString(competition?.shortName) ??
      String(fixture.leagueId),
    fixtureDate: new Date(fixture.fixtureDate),
    live: fixture.live === true,
    completed: fixture.completed === true,
    homeTeamId: String(fixture.homeTeamId),
    homeTeamName: home.name,
    awayTeamId: String(fixture.awayTeamId),
    awayTeamName: away.name,
    venueName:
      asNonEmptyString(venue?.fullName) ??
      asNonEmptyString(venue?.displayName) ??
      undefined,
    status: String(fixture.status ?? 'UNKNOWN'),
    collectedAt: new Date(fixture.collectedAt),
    summaryCollectedAt,
    payload: {
      ...payload,
      summary: summary ?? {},
    },
  };
}

export function extractRosterPlayers(summary: UnknownRecord): Array<{
  id: string;
  name: string;
  abbreviation: string;
  teamId?: string;
}> {
  const rosters = asArray(summary.rosters);
  const players = new Map<
    string,
    { id: string; name: string; abbreviation: string; teamId?: string }
  >();

  const walk = (value: unknown, teamId?: string, depth = 0): void => {
    if (depth > 12) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, teamId, depth + 1);
      return;
    }
    const record = asRecord(value);
    if (!record) return;
    const team = asRecord(record.team);
    const nextTeamId = asNonEmptyString(team?.id) ?? teamId;
    const athlete = asRecord(record.athlete) ?? asRecord(record.player);
    if (athlete) walk(athlete, nextTeamId, depth + 1);

    const id = asNonEmptyString(record.id);
    const name =
      asNonEmptyString(record.displayName) ?? asNonEmptyString(record.fullName);
    const looksLikePlayer = Boolean(
      id &&
      name &&
      (record.jersey !== undefined ||
        record.position !== undefined ||
        record.athleteId !== undefined ||
        record.statistics !== undefined ||
        (record.displayName !== undefined && record.team !== undefined)),
    );
    if (looksLikePlayer && id && name) {
      const abbreviation =
        asNonEmptyString(record.shortName) ??
        asNonEmptyString(record.abbreviation) ??
        name.split(/\s+/).slice(-1)[0];
      players.set(id, { id, name, abbreviation, teamId: nextTeamId });
    }

    for (const key of [
      'athletes',
      'players',
      'roster',
      'items',
      'groups',
      'entries',
      'statistics',
    ]) {
      if (record[key] !== undefined) walk(record[key], nextTeamId, depth + 1);
    }
  };

  walk(rosters);
  return [...players.values()];
}
