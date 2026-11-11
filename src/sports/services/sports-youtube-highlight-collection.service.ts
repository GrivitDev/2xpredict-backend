import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { YOUTUBE_CONFIG } from '../config/youtube.config';
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

export type SportsYoutubeOutcome = 'FOUND' | 'NOT_FOUND' | 'SKIPPED' | 'QUOTA_EXHAUSTED' | 'ALREADY_ATTEMPTED';

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

  /** Called by fixture lifecycle follow-ups; idempotent across repeated reconciliation. */
  async ensureFirstAttempt(fixture: SportsFixtureRecord): Promise<void> {
    if (!this.isCompleted(fixture) || !this.youtube.isEnabled()) return;

    const kickoffAt = new Date(fixture.kickoffAt).getTime();
    const highlightWindowEnd =
      kickoffAt + YOUTUBE_CONFIG.highlightWindowHours * 60 * 60_000;
    if (
      !Number.isFinite(kickoffAt) ||
      Date.now() < kickoffAt ||
      Date.now() > highlightWindowEnd
    ) return;

    const competition = await this.competitionModel.findOne({ id: fixture.competitionId }).lean().exec();
    const competitionSlug = String(competition?.slug ?? fixture.competitionId).toLowerCase();
    if (!SUPPORTED_YOUTUBE_COMPETITIONS.has(competitionSlug)) return;

    const existing = await this.highlightModel.findOne({ fixtureId: fixture.id }).lean().exec();
    if (existing?.status === 'FOUND' || existing?.status === 'FAILED') return;

    const retryCount = Math.max(0, Number(existing?.retryCount ?? 0));
    if (existing?.status === 'SEARCHING') {
      const searchedAt = existing.searchedAt ? new Date(existing.searchedAt).getTime() : 0;
      // A process may have stopped after claiming the search stage. Once the
      // worker lease plus recovery margin has elapsed, advance rather than
      // leaving this fixture permanently in SEARCHING.
      if (searchedAt > 0 && Date.now() - searchedAt < 12 * 60_000) return;
    }

    const nextAttempt = existing?.status === 'PENDING' && retryCount === 0
      ? 1
      : retryCount + 1;
    if (await this.queue.hasActiveFixtureJob(
      SportsQueueJobType.YOUTUBE_HIGHLIGHT,
      fixture.id,
      nextAttempt,
    )) return;
    await this.enqueueAttempt(fixture, competitionSlug, nextAttempt);
  }

  async processAttempt(fixtureId: string, requestedAttempt = 1): Promise<SportsYoutubeOutcome> {
    const fixtureDoc = await this.fixtureModel.findOne({ id: fixtureId }).lean().exec();
    if (!fixtureDoc) throw new Error(`Normalized fixture ${fixtureId} was not found for YouTube highlight collection`);
    const fixture = fixtureDoc as unknown as SportsFixtureRecord;
    if (!this.isCompleted(fixture)) return 'SKIPPED';
    if (!this.youtube.isEnabled()) return 'SKIPPED';

    const competition = await this.competitionModel.findOne({ id: fixture.competitionId }).lean().exec();
    const competitionSlug = String(competition?.slug ?? fixture.competitionId).toLowerCase();
    if (!SUPPORTED_YOUTUBE_COMPETITIONS.has(competitionSlug)) return 'SKIPPED';

    const home = fixture.competitors.find((item) => item.homeAway === 'HOME');
    const away = fixture.competitors.find((item) => item.homeAway === 'AWAY');
    if (!home || !away) throw new Error(`Fixture ${fixture.id} is missing its home/away teams`);
    const [homeTeam, awayTeam] = await Promise.all([
      this.teamModel.findOne({ id: home.teamId }).lean().exec(),
      this.teamModel.findOne({ id: away.teamId }).lean().exec(),
    ]);
    const homeName = String(homeTeam?.displayName ?? homeTeam?.name ?? '').trim();
    const awayName = String(awayTeam?.displayName ?? awayTeam?.name ?? '').trim();
    if (!homeName || !awayName) throw new Error(`Fixture ${fixture.id} is missing normalized team names for YouTube search`);

    const kickoff = new Date(fixture.kickoffAt);
    const expiry = kickoff.getTime() + YOUTUBE_CONFIG.highlightWindowHours * 60 * 60_000;
    if (Number.isNaN(kickoff.getTime()) || Date.now() < kickoff.getTime() || Date.now() > expiry) {
      await this.markTerminal(fixture, homeName, awayName, 'YouTube highlight search window has expired or the match is not yet due.');
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

    // Claim the stage in MongoDB before making the outbound request. If the
    // worker is killed mid-call, the same stage is never repeated and charged
    // twice; lease recovery advances to the next bounded stage instead.
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

    const remaining = (await this.quota.getRemainingDailyRequests('youtube')) ?? 0;
    if (remaining <= 0) {
      await this.markTerminal(fixture, homeName, awayName, 'YouTube daily search quota is exhausted.');
      return 'QUOTA_EXHAUSTED';
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
        await this.markTerminal(fixture, homeName, awayName, `YouTube ${error.period} quota is exhausted.`);
        return 'QUOTA_EXHAUSTED';
      }
      // One provider failure consumes this staged attempt; the next official or
      // fallback channel is an independent durable job, matching the original flow.
      this.logger.warn(`YouTube attempt ${requestedAttempt}/${maximumAttempts} failed for ${fixture.id}: ${this.errorMessage(error)}`);
      await this.scheduleNext(fixture, competitionSlug, homeName, awayName, requestedAttempt, maximumAttempts, this.errorMessage(error));
      return 'NOT_FOUND';
    }
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

  private async enqueueAttempt(fixture: SportsFixtureRecord, competitionSlug: string, attempt: number): Promise<void> {
    const offsets = YOUTUBE_CONFIG.searchWorkflow.attemptOffsetsMinutes;
    if (!Number.isInteger(attempt) || attempt < 1 || attempt > offsets.length) return;
    const kickoff = new Date(fixture.kickoffAt);
    const completionReference = fixture.completedAt
      ? new Date(fixture.completedAt)
      : new Date(kickoff.getTime() + 2 * 60 * 60_000);
    const expiry = new Date(kickoff.getTime() + YOUTUBE_CONFIG.highlightWindowHours * 60 * 60_000);
    const target = new Date(completionReference.getTime() + offsets[attempt - 1] * 60_000);
    if (Date.now() > expiry.getTime() || target.getTime() > expiry.getTime()) return;
    const scheduledFor = target.getTime() > Date.now() ? target : new Date();
    if (await this.queue.hasActiveFixtureJob(
      SportsQueueJobType.YOUTUBE_HIGHLIGHT,
      fixture.id,
      attempt,
    )) return;
    await this.queue.enqueue({
      type: SportsQueueJobType.YOUTUBE_HIGHLIGHT,
      scope: {
        fixtureId: fixture.id,
        competitionId: fixture.competitionId,
        leagueId: competitionSlug,
        seasonId: fixture.seasonId,
        seasonYear: fixture.seasonYear,
        youtubeAttempt: attempt,
      },
      priority: 18,
      scheduledFor,
      triggerEventId: `youtube-highlight:${fixture.id}:attempt:${attempt}`,
    });
    await this.highlightModel.updateOne(
      { fixtureId: fixture.id, status: { $nin: ['FOUND', 'FAILED'] } },
      { $set: { status: attempt === 1 ? 'PENDING' : 'RETRY', nextRetryAt: scheduledFor } },
    ).exec();
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

  private isCompleted(fixture: SportsFixtureRecord): boolean {
    return fixture.status?.state === 'COMPLETED' || fixture.status?.isFinal === true;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message.replace(/[\r\n]+/g, ' ').slice(0, 220) : String(error).slice(0, 220);
  }
}


