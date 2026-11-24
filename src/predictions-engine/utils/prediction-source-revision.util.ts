import { createHash } from 'node:crypto';

import type { SportsSourceEntity } from '../../sports/interfaces/sports-derived-data.interface';

export interface PredictionSourceFixtureLike {
  id: string;
  competitionId?: string;
  seasonId?: string;
  competitors?: Array<{
    teamId?: string;
  }>;
}

export interface PredictionSourceRevisionReader {
  getCurrentRevisions(
    entity: SportsSourceEntity,
    entityIds: string[],
  ): Promise<Map<string, number>>;
}

export interface PredictionSourceRevisionSnapshot {
  fixtureSourceRevision: number;
  fingerprint: string;
}

const uniqueIds = (values: Array<string | undefined | null>): string[] =>
  [...new Set(values.map((value) => String(value ?? '').trim()).filter(Boolean))].sort();

/**
 * Builds one deterministic source-generation fingerprint per fixture. The
 * fingerprint covers the fixture, both participating teams, their roster
 * generations, competition/season generations and fixture-scoped match facts.
 * Batched reads keep queue reconciliation bounded instead of issuing one
 * revision query per fixture.
 */
export async function getPredictionSourceRevisionSnapshots(
  fixtures: PredictionSourceFixtureLike[],
  revisions: PredictionSourceRevisionReader,
): Promise<Map<string, PredictionSourceRevisionSnapshot>> {
  const uniqueFixturesById = new Map<string, PredictionSourceFixtureLike>();
  for (const fixture of fixtures) {
    const id = String(fixture?.id ?? '').trim();
    if (id) uniqueFixturesById.set(id, fixture);
  }

  const rows = [...uniqueFixturesById.values()];
  const fixtureIds = uniqueIds(rows.map((fixture) => fixture.id));
  const teamIds = uniqueIds(rows.flatMap((fixture) =>
    (fixture.competitors ?? []).map((competitor) => competitor.teamId),
  ));
  const competitionIds = uniqueIds(rows.map((fixture) => fixture.competitionId));
  const seasonIds = uniqueIds(rows.map((fixture) => fixture.seasonId));

  const read = async (entity: SportsSourceEntity, ids: string[]) =>
    ids.length ? revisions.getCurrentRevisions(entity, ids) : new Map<string, number>();

  const [fixtureRevisions, teamRevisions, rosterRevisions, competitionRevisions,
    seasonRevisions, statisticsRevisions, lineupRevisions, timelineRevisions] =
    await Promise.all([
      read('FIXTURE', fixtureIds),
      read('TEAM', teamIds),
      read('TEAM_ROSTER', teamIds),
      read('COMPETITION', competitionIds),
      read('SEASON', seasonIds),
      read('MATCH_STATISTICS', fixtureIds),
      read('MATCH_LINEUP', fixtureIds),
      read('MATCH_TIMELINE', fixtureIds),
    ]);

  const revision = (map: Map<string, number>, id: string | undefined): number =>
    id ? Number(map.get(id) ?? 0) : 0;

  const snapshots = new Map<string, PredictionSourceRevisionSnapshot>();
  for (const fixture of rows) {
    const fixtureId = String(fixture.id);
    const fixtureSourceRevision = revision(fixtureRevisions, fixtureId);
    const participatingTeams = uniqueIds(
      (fixture.competitors ?? []).map((competitor) => competitor.teamId),
    );

    // Fixed key ordering plus sorted ID arrays makes this hash independent of
    // MongoDB result order and stable across application instances.
    const sourceState = {
      fixture: [fixtureId, fixtureSourceRevision],
      teams: participatingTeams.map((id) => [id, revision(teamRevisions, id)]),
      teamRosters: participatingTeams.map((id) => [id, revision(rosterRevisions, id)]),
      competition: [
        String(fixture.competitionId ?? ''),
        revision(competitionRevisions, fixture.competitionId),
      ],
      season: [String(fixture.seasonId ?? ''), revision(seasonRevisions, fixture.seasonId)],
      matchStatistics: [fixtureId, revision(statisticsRevisions, fixtureId)],
      matchLineup: [fixtureId, revision(lineupRevisions, fixtureId)],
      matchTimeline: [fixtureId, revision(timelineRevisions, fixtureId)],
    };
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(sourceState))
      .digest('hex');

    snapshots.set(fixtureId, { fixtureSourceRevision, fingerprint });
  }

  return snapshots;
}
