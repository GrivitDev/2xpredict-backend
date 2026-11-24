import { getPredictionSourceRevisionSnapshots } from './prediction-source-revision.util';
import type { PredictionSourceFixtureLike } from './prediction-source-revision.util';

describe('getPredictionSourceRevisionSnapshots', () => {
  const fixture: PredictionSourceFixtureLike = {
    id: 'fixture-1',
    competitionId: 'competition-1',
    seasonId: 'season-1',
    competitors: [
      { teamId: 'team-home' },
      { teamId: 'team-away' },
    ],
  };

  it('creates a deterministic fingerprint from all relevant Sports revisions', async () => {
    const revisionValues: Record<string, Map<string, number>> = {
      FIXTURE: new Map([['fixture-1', 3]]),
      TEAM: new Map([['team-home', 4], ['team-away', 7]]),
      TEAM_ROSTER: new Map([['team-home', 2], ['team-away', 5]]),
      COMPETITION: new Map([['competition-1', 6]]),
      SEASON: new Map([['season-1', 8]]),
      MATCH_STATISTICS: new Map([['fixture-1', 9]]),
      MATCH_LINEUP: new Map([['fixture-1', 10]]),
      MATCH_TIMELINE: new Map([['fixture-1', 11]]),
    };
    const revisions = {
      getCurrentRevisions: jest.fn(async (entity: string, ids: string[]) =>
        new Map<string, number>(ids.map((id): [string, number] => [id, revisionValues[entity]?.get(id) ?? 0])),
      ),
    };

    const [first] = await Promise.all([
      getPredictionSourceRevisionSnapshots([fixture], revisions as any),
      getPredictionSourceRevisionSnapshots([{
        ...fixture,
        competitors: [...(fixture.competitors ?? [])].reverse(),
      }], revisions as any),
    ]);
    const second = await getPredictionSourceRevisionSnapshots([{
      ...fixture,
      competitors: [...(fixture.competitors ?? [])].reverse(),
    }], revisions as any);

    expect(first.get('fixture-1')?.fixtureSourceRevision).toBe(3);
    expect(first.get('fixture-1')?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.get('fixture-1')?.fingerprint).toBe(second.get('fixture-1')?.fingerprint);
    expect(revisions.getCurrentRevisions).toHaveBeenCalledWith('TEAM_ROSTER', [
      'team-away', 'team-home',
    ]);
  });

  it('changes the combined fingerprint when a related team revision advances', async () => {
    let homeTeamRevision = 1;
    const revisions = {
      getCurrentRevisions: jest.fn(async (entity: string, ids: string[]) => {
        const value = entity === 'FIXTURE' ? 12
          : entity === 'TEAM' && ids.includes('team-home') ? homeTeamRevision
            : 0;
        return new Map<string, number>(ids.map((id): [string, number] => [id, value]));
      }),
    };

    const before = (await getPredictionSourceRevisionSnapshots(
      [fixture], revisions as any,
    )).get('fixture-1');
    homeTeamRevision = 2;
    const after = (await getPredictionSourceRevisionSnapshots(
      [fixture], revisions as any,
    )).get('fixture-1');

    expect(after?.fixtureSourceRevision).toBe(before?.fixtureSourceRevision);
    expect(after?.fingerprint).not.toBe(before?.fingerprint);
  });
});
