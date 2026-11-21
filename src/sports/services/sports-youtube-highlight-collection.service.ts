import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { getYoutubeLeaguePriority, YOUTUBE_CONFIG } from '../config/youtube.config';
import { getYoutubeHighlightSearchPlan } from '../enums/official-youtube-channel.enum';
import { SportsQueueJobType } from '../interfaces/sports-queue.interface';
import { SportsFixtureRecord } from '../interfaces/sports-domain.interface';
import { SportsYoutubeHighlight } from '../schemas/domain/youtube-highlight.schema';
import { SportsFixture, SportsCompetition, SportsTeam } from '../schemas';
import { SportsQueueService } from './sports-queue.service';
import { YoutubeService } from '../providers/youtube.service';
import {
  SportsProviderQuotaExceededError,
  SportsProviderRateLimitService,
} from './sports-provider-rate-limit.service';

const SUPPORTED_YOUTUBE_COMPETITIONS = new Set<string>(
  YOUTUBE_CONFIG.supportedCompetitionSlugs.map((value) => value.toLowerCase()),
);
const HIGHLIGHT_RECONCILIATION_LOOKBACK_MS =
  YOUTUBE_CONFIG.reconciliationLookbackDays * 24 * 60 * 60_000;
const SEARCHING_RECOVERY_GRACE_MS = 12 * 60_000;

export type SportsYoutubeOutcome =
  | 'FOUND'
  | 'NOT_FOUND'
  | 'SKIPPED'
  | 'QUOTA_EXHAUSTED'
  | 'ALREADY_ATTEMPTED';

/**
 * YouTube is an independent media workflow. It consumes completed normalized
 * fixtures only; it never calls ESPN or writes sports match facts.
 * Every durable queue job performs exactly one YouTube search stage.
 */
@Injectable()
export class SportsYoutubeHighlightCollectionService {
  private readonly logger = new Logger(SportsYoutubeHighlightCollectionService.name);

  constructor(
    private readonly youtube: YoutubeService,
    private readonly quota: SportsProviderRateLimitService,
    private readonly queue: SportsQueueService,
    @InjectModel(SportsFixture.name) private readonly fixtureModel: Model<any>,
    @InjectModel(SportsCompetition.name) private readonly competitionModel: Model<any>,
    @InjectModel(SportsTeam.name) private readonly teamModel: Model<any>,
    @InjectModel(SportsYoutubeHighlight.name) private readonly highlightModel: Model<any>,
  ) {}

  /**
   * Periodic safety net for completed fixtures whose original post-match
   * follow-up was missed, quarantined, or completed before highlight collection
   * was enabled. A 30-day lookback is a recovery boundary, not a publication
   * expiry; queued jobs can still resume after longer quota pauses.
   */
  async reconcileRecentCompletedFixtures(
    limit = 100,
  ): Promise<{ scanned: number; scheduled: number }> {
    if (!this.youtube.isEnabled()) return { scanned: 0, scheduled: 0 };

    const now = new Date();
    const cutoff = new Date(now.getTime() - HIGHLIGHT_RECONCILIATION_LOOKBACK_MS);
    const requestedLimit = Math.floor(Number(limit));
    const safeLimit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(500, requestedLimit))
      : 100;
    const fixtures = await this.fixtureModel.aggregate([
      {
        $match: {
          kickoffAt: { $gte: cutoff, $lte: now },
          $or: [
            { 'status.state': 'COMPLETED' },
            { 'status.isFinal': true },
          ],
        },
      },
      {
        $lookup: {
          from: 'sports_competitions',
          localField: 'competitionId',
          foreignField: 'id',
          as: 'competition',
        },
      },
      { $unwind: '$competition' },
      {
        $match: {
          'competition.slug': { $in: [...SUPPORTED_YOUTUBE_COMPETITIONS] },
        },
      },
      {
        $lookup: {
          from: 'sports_youtube_highlights',
          localField: 'id',
          foreignField: 'fixtureId',
          as: 'highlight',
        },
      },
      {
        $unwind: {
          path: '$highlight',
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $lookup: {
          from: 'sports_queue_jobs',
          let: { fixtureKey: '$id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$type', 'YOUTUBE_HIGHLIGHT'] },
                    { $eq: ['$scope.fixtureId', '$$fixtureKey'] },
                    { $in: ['$status', ['PENDING', 'PROCESSING']] },
                  ],
                },
              },
            },
            { $project: { _id: 1 } },
          ],
          as: 'activeHighlightJobs',
        },
      },
      {
        $match: {
          activeHighlightJobs: { $size: 0 },
          $or: [
            { highlight: null },
            { 'highlight.status': { $in: ['PENDING', 'RETRY'] } },
            {
              $and: [
                { 'highlight.status': 'SEARCHING' },
                {
                  $or: [
                    { 'highlight.searchedAt': { $exists: false } },
                    { 'highlight.searchedAt': { $lte: new Date(now.getTime() - SEARCHING_RECOVERY_GRACE_MS) } },
                  ],
                },
              ],
            },
            {
              $and: [
                { 'highlight.status': 'FAILED' },
                { 'highlight.error': /quota.*exhausted|exhausted.*quota/i },
              ],
            },
          ],
        },
      },
      { $sort: { kickoffAt: 1, id: 1 } },
      { $limit: safeLimit },
      {
        $project: {
          id: 1,
          competitionId: 1,
          seasonId: 1,
          seasonYear: 1,
          kickoffAt: 1,
          completedAt: 1,
          status: 1,
        },
      },
    ]).exec() as SportsFixtureRecord[];

    let scheduled = 0;
    let failed = 0;
    for (const fixture of fixtures) {
      try {
        if (await this.ensureFirstAttempt(fixture)) scheduled += 1;
      } catch (error) {
        failed += 1;
        this.logger.warn(
          `YouTube highlight reconciliation could not resume fixture ${fixture.id}: ${this.errorMessage(error)}`,
        );
      }
    }

    if (fixtures.length > 0) {
      this.logger.log(
        `YouTube highlight reconciliation checked ${fixtures.length} recent completed fixture(s); queued or resumed ${scheduled}; fixture errors=${failed}.`,
      );
    }
    return { scanned: fixtures.length, scheduled };
  }

  /** Called by fixture lifecycle follow-ups; idempotent across repeated reconciliation. */
  async ensureFirstAttempt(fixture: SportsFixtureRecord): Promise<boolean> {
    if (!this.isCompleted(fixture) || !this.youtube.isEnabled()) return false;

    const kickoffAt = new Date(fixture.kickoffAt).getTime();
    // Do not expire completed fixtures after 24 hours. Quota-paused work must
    // remain eligible when the YouTube lane resumes on a later quota day.
    if (!Number.isFinite(kickoffAt) || Date.now() < kickoffAt) return false;

    const competition = await this.competitionModel.findOne({ id: fixture.competitionId }).lean().exec();
    const competitionSlug = String(competition?.slug ?? fixture.competitionId).toLowerCase();
    if (!SUPPORTED_YOUTUBE_COMPETITIONS.has(competitionSlug)) return false;

    const existing = await this.highlightModel.findOne({ fixtureId: fixture.id }).lean().exec();
    if (existing?.status === 'FOUND') return false;

    let retryCount = Math.max(0, Number(existing?.retryCount ?? 0));
    if (existing?.status === 'FAILED') {
      // The previous implementation marked quota exhaustion terminal after
      // claiming (and incrementing) an attempt. Recover only those known
      // quota-terminal rows; genuine no-result and data errors stay terminal.
      if (!this.isQuotaExhaustionError(existing.error)) return false;
      retryCount = Math.max(0, retryCount - 1);
      const resumed = await this.highlightModel.updateOne(
        { fixtureId: fixture.id, status: 'FAILED' },
        {
          $set: {
            status: 'RETRY',
            retryCount,
            error: 'Resuming a previously quota-paused highlight search.',
            nextRetryAt: null,
          },
        },
      ).exec();
      if (Number(resumed.modifiedCount ?? 0) !== 1) return false;
    }
    const maximumAttempts = Math.min(
      YOUTUBE_CONFIG.searchWorkflow.maximumRequestsPerFixture,
      YOUTUBE_CONFIG.searchWorkflow.attemptOffsetsMinutes.length,
    );

    if (existing?.status === 'SEARCHING') {
      const searchedAt = existing.searchedAt ? new Date(existing.searchedAt).getTime() : 0;
      // A process may have stopped after claiming the search stage. Wait while
      // its queue job is still active; the queue lease recovery owns that job.
      if (searchedAt > 0 && Date.now() - searchedAt < SEARCHING_RECOVERY_GRACE_MS) {
        return false;
      }
      if (retryCount > 0 && await this.queue.hasActiveFixtureJob(
        SportsQueueJobType.YOUTUBE_HIGHLIGHT,
        fixture.id,
        retryCount,
      )) return false;
    }

    if (retryCount >= maximumAttempts) {
      await this.markTerminal(
        fixture,
        String(existing?.homeTeam ?? 'Unknown home team'),
        String(existing?.awayTeam ?? 'Unknown away team'),
        `YouTube highlight workflow reached its ${maximumAttempts}-attempt limit without a saved video.`,
      );
      return false;
    }

    const nextAttempt = existing?.status === 'PENDING' && retryCount === 0
      ? 1
      : retryCount + 1;
    if (await this.queue.hasActiveFixtureJob(
      SportsQueueJobType.YOUTUBE_HIGHLIGHT,
      fixture.id,
      nextAttempt,
    )) return false;
    return this.enqueueAttempt(fixture, competitionSlug, nextAttempt);
  }

  async processAttempt(
    fixtureId: string,
    requestedAttempt = 1,
    currentJobKey?: string,
  ): Promise<SportsYoutubeOutcome> {
    const fixtureDoc = await this.fixtureModel.findOne({ id: fixtureId }).lean().exec();
    if (!fixtureDoc) throw new Error(`Normalized fixture ${fixtureId} was not found for YouTube highlight collection`);
    const fixture = fixtureDoc as unknown as SportsFixtureRecord;
    if (!this.isCompleted(fixture)) return 'SKIPPED';
    if (!this.youtube.isEnabled()) return 'SKIPPED';

    const competition = await this.competitionModel.findOne({ id: fixture.competitionId }).lean().exec();
    const competitionSlug = String(competition?.slug ?? fixture.competitionId).toLowerCase();
    if (!SUPPORTED_YOUTUBE_COMPETITIONS.has(competitionSlug)) return 'SKIPPED';

    const competitors = Array.isArray(fixture.competitors)
      ? fixture.competitors
      : [];
    const home = competitors.find((item) => item.homeAway === 'HOME');
    const away = competitors.find((item) => item.homeAway === 'AWAY');

    if (!home || !away) {
      const reason =
        'YouTube highlight skipped because the normalized fixture does not contain both home and away competitors.';
      await this.markTerminal(
        fixture,
        this.missingTeamLabel('home'),
        this.missingTeamLabel('away'),
        reason,
      );
      this.logger.warn(`Skipping YouTube highlight for fixture ${fixture.id}: ${reason}`);
      return 'SKIPPED';
    }

    const homeTeamId = String(home.teamId ?? '').trim();
    const awayTeamId = String(away.teamId ?? '').trim();
    if (!homeTeamId || !awayTeamId) {
      const missingReferences = [
        !homeTeamId ? 'home team ID' : undefined,
        !awayTeamId ? 'away team ID' : undefined,
      ].filter((value): value is string => Boolean(value));
      const reason =
        `YouTube highlight skipped because the fixture is missing its ${missingReferences.join(' and ')}.`;
      await this.markTerminal(
        fixture,
        this.missingTeamLabel('home', homeTeamId),
        this.missingTeamLabel('away', awayTeamId),
        reason,
      );
      this.logger.warn(`Skipping YouTube highlight for fixture ${fixture.id}: ${reason}`);
      return 'SKIPPED';
    }

    const [homeTeam, awayTeam] = await Promise.all([
      this.teamModel.findOne({ id: homeTeamId }).lean().exec(),
      this.teamModel.findOne({ id: awayTeamId }).lean().exec(),
    ]);
    const homeName = this.normalizedTeamName(homeTeam);
    const awayName = this.normalizedTeamName(awayTeam);
    if (!homeName || !awayName) {
      const missingNames = [
        !homeName ? `home team ${homeTeamId}` : undefined,
        !awayName ? `away team ${awayTeamId}` : undefined,
      ].filter((value): value is string => Boolean(value));
      const reason =
        `YouTube highlight skipped because normalized name data is unavailable for ${missingNames.join(' and ')}.`;
      await this.markTerminal(
        fixture,
        homeName || this.missingTeamLabel('home', homeTeamId),
        awayName || this.missingTeamLabel('away', awayTeamId),
        reason,
      );
      this.logger.warn(`Skipping YouTube highlight for fixture ${fixture.id}: ${reason}`);
      return 'SKIPPED';
    }

    const kickoff = new Date(fixture.kickoffAt);
    if (Number.isNaN(kickoff.getTime()) || Date.now() < kickoff.getTime()) {
      await this.markTerminal(fixture, homeName, awayName, 'YouTube highlight search is not valid before match kickoff.');
      return 'SKIPPED';
    }

    const plan = getYoutubeHighlightSearchPlan(competitionSlug, homeName, awayName);
    const maximumAttempts = Math.min(
      YOUTUBE_CONFIG.searchWorkflow.maximumRequestsPerFixture,
      YOUTUBE_CONFIG.searchWorkflow.attemptOffsetsMinutes.length,
      plan.length,
    );
    if (!Number.isInteger(requestedAttempt) || requestedAttempt < 1 || requestedAttempt > maximumAttempts) {
      await this.markTerminal(fixture, homeName, awayName, `Invalid or exhausted YouTube attempt ${requestedAttempt}.`);
      return 'SKIPPED';
    }

    const row = await this.ensureHighlightRow(fixture, competitionSlug, homeName, awayName);
    if (row.status === 'FOUND' && row.videoId) return 'FOUND';
    if (row.status === 'FAILED') return 'SKIPPED';

    // Check quota before claiming the stage. A depleted daily allowance must
    // defer the same stage instead of consuming an attempt or terminalising it.
    const remaining = await this.quota.getRemainingDailyRequests('youtube');
    if (remaining !== null && remaining <= 0) {
      await this.deferAttemptUntilQuotaReset(
        fixture,
        competitionSlug,
        homeName,
        awayName,
        requestedAttempt,
        'YouTube daily search quota is exhausted; the search is deferred until the next Nigeria-time quota day.',
        currentJobKey,
      );
      return 'QUOTA_EXHAUSTED';
    }

    // Claim the stage in MongoDB before making the outbound request. If the
    // worker is killed mid-call, central queue-lease recovery and the periodic
    // reconciliation job advance abandoned work without repeating a charge.
    const claim = await this.highlightModel.findOneAndUpdate(
      {
        fixtureId: fixture.id,
        status: { $nin: ['FOUND', 'FAILED'] },
        retryCount: { $lt: requestedAttempt },
      },
      {
        $set: { status: 'SEARCHING', searchedAt: new Date(), error: null },
        $inc: { retryCount: 1 },
      },
      { returnDocument: 'after' },
    ).lean().exec();

    if (!claim) {
      const latest = await this.highlightModel.findOne({ fixtureId: fixture.id }).lean().exec();
      if (latest?.status === 'FOUND' && latest.videoId) return 'FOUND';
      if (latest?.status === 'FAILED') return 'SKIPPED';
      const consumedAttempt = Math.max(requestedAttempt, Number(latest?.retryCount ?? requestedAttempt));
      await this.enqueueAttempt(fixture, competitionSlug, consumedAttempt + 1);
      return 'ALREADY_ATTEMPTED';
    }

    const channelReference = plan[requestedAttempt - 1] ?? undefined;
    try {
      const result = await this.youtube.findHighlight(homeName, awayName, kickoff, channelReference);
      if (result) {
        await this.highlightModel.updateOne(
          { fixtureId: fixture.id },
          {
            $set: {
              status: 'FOUND', videoId: result.videoId, videoUrl: result.videoUrl,
              title: result.title, channelId: result.channelId,
              channelTitle: result.channelTitle,
              publishedAt: result.publishedAt ? new Date(result.publishedAt) : undefined,
              thumbnailUrl: result.thumbnailUrl,
              nextRetryAt: null, error: null,
            },
          },
        ).exec();
        this.logger.log(`YouTube highlight found for ${competitionSlug}/${fixture.espnEventId} on attempt ${requestedAttempt}/${maximumAttempts}.`);
        return 'FOUND';
      }
      await this.scheduleNext(fixture, competitionSlug, homeName, awayName, requestedAttempt, maximumAttempts, 'No suitable video was found on this channel stage.');
      return 'NOT_FOUND';
    } catch (error) {
      if (error instanceof SportsProviderQuotaExceededError && error.provider === 'youtube') {
        const reason = `YouTube ${error.period} quota is exhausted; the search stage has been deferred.`;
        // The provider quota reservation is atomic. If another process consumed
        // the final slot between our pre-check and the request, roll back this
        // uncharged stage claim and retry the same stage after the quota reset.
        await this.highlightModel.updateOne(
          {
            fixtureId: fixture.id,
            status: 'SEARCHING',
            retryCount: requestedAttempt,
          },
          {
            $inc: { retryCount: -1 },
            $set: { status: 'RETRY', error: reason },
          },
        ).exec();
        await this.deferAttemptUntilQuotaReset(
          fixture,
          competitionSlug,
          homeName,
          awayName,
          requestedAttempt,
          reason,
          currentJobKey,
          error.period,
        );
        return 'QUOTA_EXHAUSTED';
      }
      // One provider failure consumes this staged attempt; the next official or
      // fallback channel is an independent durable job, matching the original flow.
      this.logger.warn(`YouTube attempt ${requestedAttempt}/${maximumAttempts} failed for ${fixture.id}: ${this.errorMessage(error)}`);
      await this.scheduleNext(fixture, competitionSlug, homeName, awayName, requestedAttempt, maximumAttempts, this.errorMessage(error));
      return 'NOT_FOUND';
    }
  }

  private async deferAttemptUntilQuotaReset(
    fixture: SportsFixtureRecord,
    competitionSlug: string,
    homeName: string,
    awayName: string,
    attempt: number,
    reason: string,
    currentJobKey?: string,
    period: 'daily' | 'monthly' = 'daily',
  ): Promise<void> {
    const retryAt = period === 'monthly'
      ? this.getNextUtcMonthStart()
      : this.getNextLagosMidnight();
    // Keep the current stage pending for the next quota period. There is no
    // post-kickoff publication expiry, so an overnight pause cannot terminalise it.
    await this.highlightModel.updateOne(
      { fixtureId: fixture.id, status: { $nin: ['FOUND', 'FAILED'] } },
      { $set: { status: 'RETRY', error: reason, nextRetryAt: retryAt } },
    ).exec();
    await this.enqueueAttempt(fixture, competitionSlug, attempt, retryAt, currentJobKey);
  }

  private async scheduleNext(
    fixture: SportsFixtureRecord,
    competitionSlug: string,
    homeName: string,
    awayName: string,
    currentAttempt: number,
    maximumAttempts: number,
    reason: string,
  ): Promise<void> {
    const nextAttempt = currentAttempt + 1;
    if (nextAttempt > maximumAttempts) {
      await this.markTerminal(fixture, homeName, awayName, `No suitable highlight found after ${currentAttempt} search request(s). ${reason}`);
      return;
    }
    await this.highlightModel.updateOne(
      { fixtureId: fixture.id, status: { $ne: 'FOUND' } },
      { $set: { status: 'RETRY', error: reason } },
    ).exec();
    await this.enqueueAttempt(fixture, competitionSlug, nextAttempt);
  }

  private async enqueueAttempt(
    fixture: SportsFixtureRecord,
    competitionSlug: string,
    attempt: number,
    scheduledForOverride?: Date,
    excludeActiveJobKey?: string,
  ): Promise<boolean> {
    const offsets = YOUTUBE_CONFIG.searchWorkflow.attemptOffsetsMinutes;
    if (!Number.isInteger(attempt) || attempt < 1 || attempt > offsets.length) return false;
    const kickoff = new Date(fixture.kickoffAt);
    const completionReference = fixture.completedAt
      ? new Date(fixture.completedAt)
      : new Date(kickoff.getTime() + 2 * 60 * 60_000);
    const target = new Date(completionReference.getTime() + offsets[attempt - 1] * 60_000);
    const now = Date.now();
    // Round overdue enqueue times to a stable minute so concurrent lifecycle
    // passes produce the same durable job identity instead of duplicate jobs.
    const immediateDueAt = new Date(Math.floor(now / 60_000) * 60_000);
    const scheduledFor = scheduledForOverride ?? (target.getTime() > now ? target : immediateDueAt);
    if (await this.queue.hasActiveFixtureJob(
      SportsQueueJobType.YOUTUBE_HIGHLIGHT,
      fixture.id,
      attempt,
      excludeActiveJobKey,
    )) return false;
    const result = await this.queue.enqueue({
      type: SportsQueueJobType.YOUTUBE_HIGHLIGHT,
      scope: {
        fixtureId: fixture.id,
        competitionId: fixture.competitionId,
        leagueId: competitionSlug,
        seasonId: fixture.seasonId,
        seasonYear: fixture.seasonYear,
        youtubeAttempt: attempt,
      },
      priority: getYoutubeLeaguePriority(competitionSlug),
      scheduledFor,
      triggerEventId: `youtube-highlight:${fixture.id}:attempt:${attempt}`,
    });
    await this.highlightModel.updateOne(
      { fixtureId: fixture.id, status: { $nin: ['FOUND', 'FAILED'] } },
      { $set: { status: attempt === 1 ? 'PENDING' : 'RETRY', nextRetryAt: scheduledFor } },
    ).exec();
    return result.created;
  }

  private async ensureHighlightRow(
    fixture: SportsFixtureRecord,
    competitionId: string,
    homeTeam: string,
    awayTeam: string,
  ): Promise<any> {
    await this.highlightModel.updateOne(
      { fixtureId: fixture.id },
      {
        $setOnInsert: {
          fixtureId: fixture.id,
          competitionId,
          homeTeam,
          awayTeam,
          status: 'PENDING',
          retryCount: 0,
        },
      },
      { upsert: true, setDefaultsOnInsert: true },
    ).exec();
    const row = await this.highlightModel.findOne({ fixtureId: fixture.id }).lean().exec();
    if (!row) throw new Error(`YouTube highlight state could not be initialized for ${fixture.id}`);
    return row;
  }

  private async markTerminal(
    fixture: SportsFixtureRecord,
    homeTeam: string,
    awayTeam: string,
    reason: string,
  ): Promise<void> {
    await this.highlightModel.updateOne(
      { fixtureId: fixture.id },
      {
        $set: {
          fixtureId: fixture.id,
          competitionId: fixture.competitionId, homeTeam, awayTeam,
          status: 'FAILED', error: reason, nextRetryAt: null,
        },
        $setOnInsert: { retryCount: 0 },
      },
      { upsert: true, setDefaultsOnInsert: true },
    ).exec();
  }

  private normalizedTeamName(team: any): string {
    const displayName = String(team?.displayName ?? '').trim();
    if (displayName) return displayName;
    return String(team?.name ?? '').trim();
  }

  private missingTeamLabel(side: 'home' | 'away', teamId?: string): string {
    const normalizedId = String(teamId ?? '').trim();
    return normalizedId
      ? `Unknown ${side} team (${normalizedId})`
      : `Unknown ${side} team`;
  }

  private getNextLagosMidnight(from = new Date()): Date {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Lagos',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(from);
    const values = new Map(parts.map((part) => [part.type, part.value]));
    return new Date(
      Date.UTC(
        Number(values.get('year')),
        Number(values.get('month')) - 1,
        Number(values.get('day')) + 1,
        0,
        0,
        0,
      ) - 60 * 60_000,
    );
  }

  private getNextUtcMonthStart(from = new Date()): Date {
    return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
  }

  private isCompleted(fixture: SportsFixtureRecord): boolean {
    return fixture.status?.state === 'COMPLETED' || fixture.status?.isFinal === true;
  }

  private isQuotaExhaustionError(value: unknown): boolean {
    return /quota.*exhausted|exhausted.*quota/i.test(String(value ?? ''));
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message.replace(/[\r\n]+/g, ' ').slice(0, 220) : String(error).slice(0, 220);
  }
}
