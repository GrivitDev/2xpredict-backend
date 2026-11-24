import { Injectable, Logger } from '@nestjs/common';

import type {
  SportsFixtureRecord,
  SportsTeamRecord,
} from '../interfaces/sports-domain.interface';
import { SportsQueueJobType } from '../interfaces/sports-queue.interface';
import { SPORTS_COLLECTION_SCHEDULE } from '../config/sports-collection-schedule.config';
import { SportsPersistenceService } from './sports-persistence.service';
import { SportsProviderCollectionService } from './sports-provider-collection.service';
import { SportsQueueService } from './sports-queue.service';

const DETAIL_REFRESH_FIELDS = [
  'espnId',
  'name',
  'displayName',
  'shortName',
  'abbreviation',
  'slug',
  'logo',
  'country',
  'location',
  'primaryColor',
  'alternateColor',
] as const;

const TEAM_METADATA_FIELDS = [...DETAIL_REFRESH_FIELDS, 'leagueIds'] as const;
const QUEUE_ENQUEUE_CONCURRENCY = 8;

export interface FixtureTeamIntegrityResult {
  fixturesChecked: number;
  uniqueTeamsChecked: number;
  teamSnapshotsExtracted: number;
  teamRecordsWritten: number;
  teamLeagueMembershipsAdded: number;
  missingTeamRecordIds: string[];
  identityMismatchTeamIds: string[];
  incompleteTeamFields: Record<string, string[]>;
  detailRefreshJobsQueued: string[];
  detailRefreshJobsSkippedByCooldown: string[];
}

/**
 * Verifies all team references in newly collected or refreshed fixtures.
 *
 * The steady-state path performs one bounded team read and local normalization.
 * It skips Mongo writes when the stored identity is already current. Missing or
 * incomplete records are enriched from the fixture snapshot and/or scheduled
 * for the existing durable TEAM_DETAIL_REFRESH workflow.
 */
@Injectable()
export class SportsFixtureTeamIntegrityService {
  private readonly logger = new Logger(SportsFixtureTeamIntegrityService.name);

  constructor(
    private readonly provider: SportsProviderCollectionService,
    private readonly persistence: SportsPersistenceService,
    private readonly queue: SportsQueueService,
  ) {}

  async ensureFixtureTeams(
    leagueId: string,
    fixtures: SportsFixtureRecord[],
  ): Promise<FixtureTeamIntegrityResult> {
    const normalizedLeagueId = String(leagueId ?? '').trim().toLowerCase();
    const rows = Array.isArray(fixtures) ? fixtures : [];
    const expectedTeamIds = [
      ...new Set(
        rows
          .flatMap((fixture) =>
            (fixture.competitors ?? []).map((competitor) =>
              this.canonicalTeamId(competitor?.teamId),
            ),
          )
          .filter(Boolean),
      ),
    ];

    const result: FixtureTeamIntegrityResult = {
      fixturesChecked: rows.length,
      uniqueTeamsChecked: expectedTeamIds.length,
      teamSnapshotsExtracted: 0,
      teamRecordsWritten: 0,
      teamLeagueMembershipsAdded: 0,
      missingTeamRecordIds: [],
      identityMismatchTeamIds: [],
      incompleteTeamFields: {},
      detailRefreshJobsQueued: [],
      detailRefreshJobsSkippedByCooldown: [],
    };

    if (!normalizedLeagueId || !rows.length || !expectedTeamIds.length) {
      return result;
    }

    const expectedIds = new Set(expectedTeamIds);

    // One bounded read gives us the existing records and detects a legacy row
    // whose ESPN ID is owned by a different canonical document.
    let storedRows = await this.persistence.getTeamsByIdentifiers(expectedTeamIds);
    const conflictingCanonicalIds = this.findCanonicalIdConflicts(
      expectedTeamIds,
      storedRows,
    );

    // Read the already-collected competitor snapshots. No provider/network call
    // is made here. The normalizer is the single source of canonical ID rules.
    const snapshots = this.provider
      .normalizeTeamsFromFixtures(rows, normalizedLeagueId)
      .filter((team) => {
        const canonicalId = this.canonicalTeamId(team?.id);
        const espnId = this.rawTeamId(team?.espnId);
        return (
          Boolean(canonicalId) &&
          expectedIds.has(canonicalId) &&
          Boolean(espnId) &&
          canonicalId === `team:${espnId}`
        );
      });

    const snapshotsById = new Map<string, SportsTeamRecord>();
    for (const snapshot of snapshots) {
      const id = this.canonicalTeamId(snapshot.id);
      if (id && !conflictingCanonicalIds.has(id)) snapshotsById.set(id, snapshot);
    }
    result.teamSnapshotsExtracted = snapshotsById.size;

    const storedById = this.indexStoredTeamsByCanonicalId(storedRows);
    const snapshotsToWrite = [...snapshotsById.values()].filter((snapshot) =>
      this.snapshotNeedsPersistence(
        snapshot,
        storedById.get(this.canonicalTeamId(snapshot.id)),
        normalizedLeagueId,
      ),
    );

    let persistenceChanged = false;
    if (snapshotsToWrite.length) {
      result.teamRecordsWritten = await this.persistence.saveTeams(snapshotsToWrite);
      persistenceChanged = true;
    }

    // A team can be referenced by a fixture in a competition without its
    // league membership being present (for example, after an old partial import).
    // Repair membership locally; this does not require another ESPN request.
    const snapshotIdsWritten = new Set(
      snapshotsToWrite.map((team) => this.canonicalTeamId(team.id)),
    );
    const membershipIds = expectedTeamIds.filter((teamId) => {
      const stored = storedById.get(teamId);
      return Boolean(
        stored &&
          !conflictingCanonicalIds.has(teamId) &&
          !(stored.leagueIds ?? []).includes(normalizedLeagueId) &&
          !snapshotIdsWritten.has(teamId),
      );
    });
    if (membershipIds.length) {
      result.teamLeagueMembershipsAdded =
        await this.persistence.ensureTeamLeagueMembership(
          membershipIds,
          normalizedLeagueId,
        );
      persistenceChanged = persistenceChanged || result.teamLeagueMembershipsAdded > 0;
    }

    // Only pay for a second read when we actually attempted to change data.
    // Healthy live-scoreboard refreshes therefore avoid a transaction and a
    // redundant verification query on every polling cycle.
    if (persistenceChanged) {
      storedRows = await this.persistence.getTeamsByIdentifiers(expectedTeamIds);
    }

    const teamsByCanonicalId = this.indexStoredTeamsByCanonicalId(storedRows);
    const identityMismatchIds = new Set<string>(conflictingCanonicalIds);
    const refreshTeamIds: string[] = [];

    for (const teamId of expectedTeamIds) {
      const team = teamsByCanonicalId.get(teamId);
      const storedEspnId = team ? this.rawTeamId(team.espnId) : '';
      if (team && storedEspnId && teamId !== `team:${storedEspnId}`) {
        identityMismatchIds.add(teamId);
      }

      const usableTeam =
        team && (!storedEspnId || teamId === `team:${storedEspnId}`)
          ? team
          : undefined;
      if (!usableTeam) {
        result.missingTeamRecordIds.push(teamId);
        result.incompleteTeamFields[teamId] = [...TEAM_METADATA_FIELDS];
        // A canonical document with a stale espnId can be repaired by a
        // correctly matched detail response. Only skip refresh when another
        // canonical document already owns this ESPN ID (a true unique-key conflict).
        if (!conflictingCanonicalIds.has(teamId)) {
          refreshTeamIds.push(this.rawTeamId(teamId));
        }
        continue;
      }

      const missingFields: string[] = DETAIL_REFRESH_FIELDS.filter((field) =>
        !this.hasTeamField(usableTeam, field),
      );
      if (!(usableTeam.leagueIds ?? []).includes(normalizedLeagueId)) {
        missingFields.push('leagueIds');
      }
      if (missingFields.length) {
        result.incompleteTeamFields[teamId] = missingFields;
      }
      if (missingFields.some((field) => field !== 'leagueIds')) {
        if (!identityMismatchIds.has(teamId)) {
          refreshTeamIds.push(this.rawTeamId(teamId));
        }
      }
    }

    result.identityMismatchTeamIds = [...identityMismatchIds].sort();

    const uniqueRefreshIds = [...new Set(refreshTeamIds.filter(Boolean))];
    if (uniqueRefreshIds.length) {
      const refreshInterval = Math.max(
        60_000,
        SPORTS_COLLECTION_SCHEDULE.teamDetails.intervalMs,
      );
      const recentCutoff = new Date(Date.now() - refreshInterval);
      const recentlyAttempted =
        (await this.queue.getRecentTeamDetailJobTeamIds(
          normalizedLeagueId,
          uniqueRefreshIds,
          recentCutoff,
        )) ?? new Set<string>();
      const refreshWindow = Math.floor(Date.now() / refreshInterval);

      // Bounded concurrency keeps monthly bootstrap batches quick without
      // flooding MongoDB with hundreds of simultaneous queue lookups/writes.
      for (
        let offset = 0;
        offset < uniqueRefreshIds.length;
        offset += QUEUE_ENQUEUE_CONCURRENCY
      ) {
        const batch = uniqueRefreshIds.slice(
          offset,
          offset + QUEUE_ENQUEUE_CONCURRENCY,
        );
        const outcomes = await Promise.all(
          batch.map(async (teamId) => {
            if (recentlyAttempted.has(teamId)) {
              return { teamId, created: false, skipped: true };
            }
            const trigger = `fixture-team-integrity:${normalizedLeagueId}:${teamId}:${refreshWindow}`;
            const queued = await this.queue.enqueueIfMissing({
              type: SportsQueueJobType.TEAM_DETAIL_REFRESH,
              scope: {
                leagueId: normalizedLeagueId,
                teamId,
                sourceFingerprint: trigger,
              },
              priority: 78,
              scheduledFor: new Date(),
              recurrence: {
                intervalMs: refreshInterval,
                repeatUntil: 'NEVER',
              },
              triggerEventId: trigger,
            });
            return { teamId, created: queued.created, skipped: !queued.created };
          }),
        );
        for (const outcome of outcomes) {
          if (outcome.created) result.detailRefreshJobsQueued.push(outcome.teamId);
          else result.detailRefreshJobsSkippedByCooldown.push(outcome.teamId);
        }
      }
    }

    if (
      result.missingTeamRecordIds.length ||
      result.identityMismatchTeamIds.length ||
      Object.keys(result.incompleteTeamFields).length
    ) {
      this.logger.warn(
        `Fixture team integrity: checked ${result.fixturesChecked} fixture(s), ` +
          `found ${result.missingTeamRecordIds.length} missing team record(s), ` +
          `${result.identityMismatchTeamIds.length} ID mismatch(es), ` +
          `${Object.keys(result.incompleteTeamFields).length} incomplete team record(s), ` +
          `wrote ${result.teamRecordsWritten} team record(s), ` +
          `queued ${result.detailRefreshJobsQueued.length} detail refresh job(s).`,
      );
    } else {
      this.logger.debug(
        `Fixture team integrity passed for ${result.fixturesChecked} fixture(s) and ${result.uniqueTeamsChecked} unique team(s).`,
      );
    }

    return result;
  }

  private findCanonicalIdConflicts(
    expectedTeamIds: string[],
    storedRows: SportsTeamRecord[],
  ): Set<string> {
    const expectedByEspnId = new Map(
      expectedTeamIds.map((id) => [this.rawTeamId(id), id]),
    );
    const conflicts = new Set<string>();
    for (const row of storedRows) {
      const expectedId = expectedByEspnId.get(this.rawTeamId(row.espnId));
      const storedId = this.canonicalTeamId(row.id);
      if (expectedId && storedId && storedId !== expectedId) {
        conflicts.add(expectedId);
      }
    }
    return conflicts;
  }

  private indexStoredTeamsByCanonicalId(
    storedRows: SportsTeamRecord[],
  ): Map<string, SportsTeamRecord> {
    const result = new Map<string, SportsTeamRecord>();
    for (const team of storedRows) {
      const id = this.canonicalTeamId(team.id);
      if (id) result.set(id, team);
    }
    return result;
  }

  private snapshotNeedsPersistence(
    snapshot: SportsTeamRecord,
    existing: SportsTeamRecord | undefined,
    leagueId: string,
  ): boolean {
    if (!existing) return true;

    const incomingEspnId = this.rawTeamId(snapshot.espnId);
    const existingEspnId = this.rawTeamId(existing.espnId);
    if (incomingEspnId && incomingEspnId !== existingEspnId) return true;
    if (!(existing.leagueIds ?? []).includes(leagueId)) return true;

    const incomingAt = this.dateValue(snapshot.source?.collectedAt);
    const existingAt = this.dateValue(existing.source?.collectedAt);
    const incomingIsNewer =
      existingAt === null || (incomingAt !== null && incomingAt >= existingAt);

    for (const field of DETAIL_REFRESH_FIELDS) {
      const incoming = snapshot[field];
      if (
        field === 'logo' &&
        existing.logo !== undefined &&
        !this.hasTeamField(existing, field)
      ) {
        return true;
      }
      if (!this.hasTeamField(snapshot, field)) continue;
      if (!this.hasTeamField(existing, field)) return true;
      if (
        incomingIsNewer &&
        String(incoming).trim() !== String(existing[field] ?? '').trim()
      ) {
        return true;
      }
    }
    return false;
  }

  private hasTeamField(
    team: SportsTeamRecord,
    field: (typeof DETAIL_REFRESH_FIELDS)[number],
  ): boolean {
    const value = team[field];
    if (field === 'logo') {
      if (typeof value !== 'string' || !value.trim()) return false;
      try {
        const parsed = new URL(value.trim());
        return parsed.protocol === 'https:' || parsed.protocol === 'http:';
      } catch {
        return false;
      }
    }
    return typeof value === 'string' && value.trim().length > 0;
  }

  private dateValue(value: unknown): number | null {
    const parsed = value instanceof Date ? value.getTime() : new Date(String(value ?? '')).getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }

  private canonicalTeamId(value: unknown): string {
    const raw = String(value ?? '').trim().replace(/^team:/i, '');
    return raw ? `team:${raw}` : '';
  }

  private rawTeamId(value: unknown): string {
    return String(value ?? '').trim().replace(/^team:/i, '');
  }
}
