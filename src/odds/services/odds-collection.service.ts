import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EspnFixture } from '../../sports/schemas/espn/espn-fixture.schema';
import { EspnService } from '../../sports/providers/espn.service';
import { SportsCollectionService } from '../../sports/services/sports-collection.service';
import { EspnQueueService } from '../../sports/services/espn-queue.service';
import { CompetitionPriority } from '../../sports/enums/competition-priority.enum';
import { getPriorityCompetition } from '../../sports/config/priority-competitions.config';
import { FOOTBALL_MARKET_BY_ID, canonicalLineSlug } from '../catalog/football-market-catalog';
import { getFootballProviderMapping } from '../config/football-provider-mapping';
import {
  CanonicalProviderQuote,
  ProviderCollectionResult,
} from '../providers/odds-provider.interfaces';
import {
  OddsApiEventOdds,
  OddsApiOutcome,
} from '../providers/the-odds-api.interfaces';
import { TheOddsApiService } from '../providers/the-odds-api.service';
import { OddsService } from './odds.service';
import { ODDS_CONFIG } from '../config/odds.config';

const ODDS_LOOKAHEAD_MS = ODDS_CONFIG.lookaheadHours * 60 * 60_000;
const SUMMARY_CALL_CONCURRENCY = 2;
const SUMMARY_CALL_TIMEOUT_MS = 20_000;
const PROVIDER_MATCH_TOLERANCE_MS = 6 * 60 * 60_000;

interface InternalQuote extends CanonicalProviderQuote {
  eventId: string;
}

@Injectable()
export class OddsCollectionService {
  private readonly logger = new Logger(OddsCollectionService.name);

  constructor(
    private readonly oddsApi: TheOddsApiService,
    private readonly oddsService: OddsService,
    private readonly espnService: EspnService,
    private readonly sportsCollectionService: SportsCollectionService,
    private readonly espnQueueService: EspnQueueService,
    @InjectModel(EspnFixture.name)
    private readonly fixtureModel: Model<EspnFixture>,
  ) {}


  /**
   * ESPN Summary is primary. The Odds API fills missing supported 1X2, totals,
   * and Asian-handicap provider coverage. OddsService resolves each exact
   * market/selection/line independently and preserves estimate provenance.
   */
  async collectProviderQuotes(fixtures: any[]): Promise<ProviderCollectionResult> {
    // Enforce the startup barrier at the provider-collection boundary as well
    // as in the worker, so no caller can accidentally hit ESPN/Odds API early.
    await this.espnQueueService.waitForNormalOperationsReady();

    const now = Date.now();
    const horizon = now + ODDS_LOOKAHEAD_MS;
    const candidates = fixtures.filter((fixture) =>
      this.isEligibleUpcomingOrLiveFixture(fixture, now, horizon),
    );

    // The stored ESPN Summary is the first source. If supported market coverage
    // is missing, make one bounded Summary confirmation before proceeding to the
    // Odds API and immediate historical estimates.
    const missingSummaryFixtures = candidates.filter(
      (fixture) => this.oddsService.getSummaryProviderCoverage(fixture).needsFallback,
    );
    for (let offset = 0; offset < missingSummaryFixtures.length; offset += SUMMARY_CALL_CONCURRENCY) {
      await Promise.all(
        missingSummaryFixtures.slice(offset, offset + SUMMARY_CALL_CONCURRENCY).map(
          (fixture) => this.refreshMissingOddsSummary(fixture),
        ),
      );
    }

    const summaryOddsFixtures: any[] = [];
    const fallbackCandidates: any[] = [];
    for (const fixture of candidates) {
      const hasSummaryQuote = this.oddsService.hasUsableSummaryProviderOdds(fixture);
      if (hasSummaryQuote) summaryOddsFixtures.push(fixture);
      const coverage = this.oddsService.getSummaryProviderCoverage(fixture);
      if (coverage.needsFallback) fallbackCandidates.push(fixture);
    }
    let collectionCursor: string | undefined;
    try {
      collectionCursor = await this.oddsApi.getCollectionCursor();
    } catch (error) {
      this.logger.warn(`Could not read The Odds API collection cursor; using priority order: ${error instanceof Error ? error.message : String(error)}`);
    }
    const fallbackKeys = this.rotateKeys(
      this.buildOddsApiKeys(fallbackCandidates),
      collectionCursor,
    );
    const feedRecords: Array<{ key: string; data: OddsApiEventOdds[]; fetchedAt: Date }> = [];
    const uncachedKeys: string[] = [];

    // Each sport-key feed is shared by all matching fixtures. Resolve cached
    // feeds first, then request missing feeds in bounded chunks. The provider
    // service applies a Mongo-backed 12-second interval globally across workers.
    // Cache/rate-limit failures do not block immediate history-based estimation.
    for (const key of fallbackKeys) {
      try {
        const cached = await this.oddsApi.getCachedOdds(key);
        if (cached) feedRecords.push({ key, data: cached.data, fetchedAt: cached.fetchedAt });
        else uncachedKeys.push(key);
      } catch (error) {
        this.logger.warn(`Odds API cache lookup failed for ${key}; prices will be estimated if no other feed supplies them: ${error instanceof Error ? error.message : String(error)}`);
        uncachedKeys.push(key);
      }
    }

    let oddsApiAvailable = false;
    if (uncachedKeys.length) {
      try {
        oddsApiAvailable = await this.oddsApi.isNetworkAvailable();
      } catch (error) {
        this.logger.warn(`The Odds API state could not be read; skipping provider requests and estimating missing odds: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (oddsApiAvailable) {
      const requestsPerChunk = 2;
      for (let offset = 0; offset < uncachedKeys.length; offset += requestsPerChunk) {
        let canRequest = false;
        try {
          canRequest = await this.oddsApi.isNetworkAvailable();
        } catch (error) {
          this.logger.warn(`The Odds API state lookup failed mid-pass; remaining feed keys will use estimates: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!canRequest) break;
        const chunk = uncachedKeys.slice(offset, offset + requestsPerChunk);
        const results = await Promise.all(chunk.map(async (key) => {
          try {
            return { key, result: await this.oddsApi.getOdds(key, true) };
          } catch (error) {
            this.logger.warn(`Odds API request state failed for ${key}; no retry in this pass: ${error instanceof Error ? error.message : String(error)}`);
            return { key, result: null };
          }
        }));
        for (const { key, result } of results) {
          try {
            await this.oddsApi.setCollectionCursor(key);
          } catch (error) {
            this.logger.debug(`Could not persist Odds API rotation cursor for ${key}: ${error instanceof Error ? error.message : String(error)}`);
          }
          if (result) {
            feedRecords.push({ key, data: result.data, fetchedAt: result.fetchedAt });
          }
        }
      }
    }

    const allQuotes: InternalQuote[] = [];
    const updatedAtByEvent = new Map<string, Date>();
    for (const feed of feedRecords) {
      for (const event of feed.data) {
        const match = this.matchOddsApiEvent(event, fallbackCandidates, feed.key);
        if (!match) continue;
        const quoteTime = this.latestDate(
          ...((event.bookmakers ?? []).flatMap((book) => [
            this.toDate(book.last_update),
            ...(book.markets ?? []).map((market) => this.toDate(market.last_update)),
          ])),
        ) ?? feed.fetchedAt;
        const quoteAgeMs = Date.now() - quoteTime.getTime();
        if (quoteAgeMs < -5 * 60_000 || quoteAgeMs > 12 * 60 * 60_000) {
          this.logger.debug(`Ignoring stale The Odds API event ${event.id}: quote age ${Math.round(quoteAgeMs / 3_600_000)}h.`);
          continue;
        }
        const parsed = this.parseOddsApiEvent(event, String(match.eventId), quoteTime);
        if (!parsed.length) continue;
        allQuotes.push(...parsed);
        this.setLatest(updatedAtByEvent, String(match.eventId), quoteTime);
      }
    }

    const normalized = this.calculateMarketFairOdds(allQuotes);
    const pricesByEvent = new Map<string, CanonicalProviderQuote[]>();
    for (const quote of normalized) {
      const list = pricesByEvent.get(quote.eventId) ?? [];
      list.push(quote);
      pricesByEvent.set(quote.eventId, list);
    }

    let backupStatus: { status: string; requestsToday: number; dailyLimit: number };
    try {
      backupStatus = await this.oddsApi.getStatus();
    } catch (error) {
      backupStatus = { status: 'DEGRADED', requestsToday: 0, dailyLimit: 0 };
      this.logger.warn(`Could not read Odds API status for this pass: ${error instanceof Error ? error.message : String(error)}`);
    }
    const fallbackActive = normalized.length > 0;
    const statusMessage =
      `ESPN Summary odds usable for ${summaryOddsFixtures.length}/${candidates.length} upcoming/live fixtures; ` +
      `The Odds API ${backupStatus.status} (${backupStatus.requestsToday}/${backupStatus.dailyLimit} internal daily calls); ` +
      `${normalized.length} fallback quotes mapped to ${pricesByEvent.size} fixtures.`;

    this.logger.log(
      `Odds source pass: candidates=${candidates.length}, ESPN-summary=${summaryOddsFixtures.length}, fallback-needed=${fallbackCandidates.length}, Odds-API-quotes=${normalized.length}.`,
    );

    return {
      pricesByEvent,
      updatedAtByEvent,
      primaryAvailable: summaryOddsFixtures.length > 0,
      fallbackActive,
      statusMessage,
    };
  }

  private isEligibleUpcomingOrLiveFixture(
    fixture: any,
    now: number,
    horizon: number,
  ): boolean {
    const eventId = String(fixture?.eventId ?? '').trim();
    const kickoff = this.toDate(fixture?.fixtureDate)?.getTime();
    if (!eventId || !kickoff) return false;

    const statusText = [
      fixture.status,
      fixture.statusDetail,
      fixture.statusShortDetail,
    ].filter(Boolean).map(String).join(' ').toLowerCase();
    const completed = fixture.completed === true ||
      /(^|[^a-z])(final|finished|full[ _-]?time|after extra time|after penalties|ft|aet|pen)([^a-z]|$)/i.test(statusText);
    const unavailable = /postpon|\bpst\b|cancel|\bcanc\b|abandon|delay|suspend|interrupt|void|no[_ -]?contest/i.test(statusText);
    if (completed || unavailable) return false;

    const liveStatus = /(^|[^a-z])(in[_ -]?progress|inprogress|live|half[_ -]?time|first[_ -]?half|second[_ -]?half|extra[_ -]?time|penalt(?:y|ies)|status_halftime|status_in_progress)([^a-z]|$)/i.test(statusText);
    const live = fixture.live === true || liveStatus;
    if (live) return true;
    return kickoff > now && kickoff <= horizon;
  }

  private asArray(value: unknown): any[] {
    return Array.isArray(value) ? value : [];
  }

  private hasUsableSummaryOdds(fixture: any): boolean {
    return this.oddsService.hasUsableSummaryProviderOdds(fixture);
  }

  private async refreshMissingOddsSummary(fixture: any): Promise<void> {
    const eventId = String(fixture?.eventId ?? '').trim();
    const leagueId = String(fixture?.leagueId ?? '').trim().toLowerCase();
    if (!eventId || !leagueId) return;
    const payload = this.asRecord(fixture.payload);
    const lastAttempt = this.toDate(payload.oddsSummaryAttemptedAt);
    const now = Date.now();
    if (lastAttempt && now - lastAttempt.getTime() < ODDS_CONFIG.summaryRequestCooldownMs) return;

    // Persist the attempt before calling ESPN so process restarts also observe
    // the cooldown when ESPN is unavailable or returns partial data.
    try {
      await this.fixtureModel.updateOne(
        { eventId, leagueId },
        { $set: { 'payload.oddsSummaryAttemptedAt': new Date(now) } },
      ).exec();
    } catch (error) {
      this.logger.warn(`Could not persist ESPN Summary cooldown for ${leagueId}/${eventId}: ${error instanceof Error ? error.message : String(error)}`);
      // Keep going: an audit/cooldown write failure must not block odds fallback.
    }

    try {
      const fetchedSummary = await this.withTimeout(
        this.espnService.getMatchSummary(leagueId, eventId),
        SUMMARY_CALL_TIMEOUT_MS,
        `ESPN Summary request timed out after ${SUMMARY_CALL_TIMEOUT_MS}ms`,
      );
      if (!fetchedSummary || typeof fetchedSummary !== 'object' || Array.isArray(fetchedSummary)) {
        this.logger.warn(`ESPN returned no usable Summary object for odds fixture ${leagueId}/${eventId}; trying The Odds API.`);
        return;
      }
      const persistedSummary = await this.sportsCollectionService.collectEspnMatchSummary({
        leagueId,
        eventId,
        summary: fetchedSummary,
      });
      fixture.payload = { ...payload, summary: persistedSummary, summaryCollectedAt: new Date() };
      if (!this.hasUsableSummaryOdds(fixture)) {
        this.logger.debug(`ESPN Summary for ${leagueId}/${eventId} still lacks pickcenter or odds; using The Odds API fallback.`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`On-demand ESPN Summary failed for odds fixture ${leagueId}/${eventId}; trying The Odds API fallback: ${message}`);
    }
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private asRecord(value: unknown): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, any>
      : {};
  }

  private buildOddsApiKeys(fixtures: any[]): string[] {
    const keys = new Map<string, { key: string; priority: number; kickoff: number }>();
    for (const fixture of fixtures) {
      const mapping = getFootballProviderMapping(fixture.leagueId);
      if (!mapping?.oddsApiSportKey) continue;
      const kickoff = this.toDate(fixture.fixtureDate)?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const value = {
        key: mapping.oddsApiSportKey,
        priority: this.priorityRank(String(fixture.leagueId)),
        kickoff,
      };
      const current = keys.get(value.key);
      if (!current || value.priority < current.priority || (value.priority === current.priority && value.kickoff < current.kickoff)) {
        keys.set(value.key, value);
      }
    }
    return [...keys.values()]
      .sort((a, b) => a.priority - b.priority || a.kickoff - b.kickoff || a.key.localeCompare(b.key))
      .map((item) => item.key);
  }

  private matchOddsApiEvent(event: OddsApiEventOdds, fixtures: any[], sportKey: string): any | null {
    const kickoff = this.toDate(event.commence_time);
    if (!kickoff) return null;
    const candidates = fixtures.filter((fixture) => {
      if (getFootballProviderMapping(fixture.leagueId)?.oddsApiSportKey !== sportKey) return false;
      const fixtureDate = this.toDate(fixture.fixtureDate);
      if (!fixtureDate || Math.abs(fixtureDate.getTime() - kickoff.getTime()) > PROVIDER_MATCH_TOLERANCE_MS) return false;
      return this.sameTeamPair(
        this.teamName(fixture, 'home'),
        this.teamName(fixture, 'away'),
        String(event.home_team ?? ''),
        String(event.away_team ?? ''),
      );
    });
    return candidates.sort((a, b) => {
      const ta = Math.abs((this.toDate(a.fixtureDate)?.getTime() ?? 0) - kickoff.getTime());
      const tb = Math.abs((this.toDate(b.fixtureDate)?.getTime() ?? 0) - kickoff.getTime());
      return ta - tb;
    })[0] ?? null;
  }

  private parseOddsApiEvent(event: OddsApiEventOdds, eventId: string, fetchedAt: Date): InternalQuote[] {
    const quotes: InternalQuote[] = [];
    for (const bookmaker of event.bookmakers ?? []) {
      for (const market of bookmaker.markets ?? []) {
        const marketId = this.canonicalOddsApiMarket(market.key);
        if (!marketId) continue;
        const marketTime = this.latestDate(this.toDate(market.last_update), this.toDate(bookmaker.last_update)) ?? fetchedAt;
        const marketAgeMs = Date.now() - marketTime.getTime();
        // Retrieval time is not the quote's price-update time. Expired cached
        // bookmaker quotes must not be relabelled fresh merely because fetched now.
        if (marketAgeMs < -5 * 60_000 || marketAgeMs > 12 * 60 * 60_000) continue;
        for (const outcome of market.outcomes ?? []) {
          const mapped = this.mapOddsApiSelection(marketId, outcome, event.home_team, event.away_team);
          const decimalOdds = this.parseDecimalOdds(outcome.price);
          if (!mapped || decimalOdds === null || !this.isCatalogSelection(marketId, mapped.selectionKey, mapped.line)) continue;
          quotes.push({
            eventId,
            marketId,
            selectionKey: mapped.selectionKey,
            ...(mapped.line !== undefined ? { line: mapped.line } : {}),
            decimalOdds,
            provider: 'THE_ODDS_API',
            bookmaker: String(bookmaker.title ?? bookmaker.key),
            bookmakerKey: String(bookmaker.key ?? this.slug(bookmaker.title)),
            providerUpdatedAt: marketTime,
          });
        }
      }
    }
    return quotes;
  }

  private canonicalOddsApiMarket(key: string): string | null {
    switch (key.trim().toLowerCase()) {
      case 'h2h': return 'MATCH_RESULT';
      case 'totals': return 'TOTAL_GOALS_OVER_UNDER';
      case 'spreads': return 'ASIAN_HANDICAP';
      case 'btts': return 'BOTH_TEAMS_TO_SCORE';
      case 'double_chance': return 'DOUBLE_CHANCE';
      case 'draw_no_bet': return 'DRAW_NO_BET';
      case 'h2h_h1': return 'HALF_TIME_RESULT';
      case 'totals_h1': return 'FIRST_HALF_TOTAL_GOALS';
      case 'team_totals': return null; // Team-total variants lack an unambiguous side/line contract in the standard feed.
      default: return null;
    }
  }

  private mapSelection(
    marketId: string,
    rawValue: string,
    homeTeam: string,
    awayTeam: string,
  ): { selectionKey: string; line?: number } | null {
    const value = String(rawValue ?? '').trim();
    const lower = this.slug(value);
    if (marketId === 'MATCH_RESULT' || marketId === 'HALF_TIME_RESULT') {
      if (/^(home|home win|1|1x2 home)$/.test(lower) || this.sameTeam(value, homeTeam)) return { selectionKey: 'HOME_WIN' };
      if (/^(draw|tie|x)$/.test(lower)) return { selectionKey: 'DRAW' };
      if (/^(away|away win|2|1x2 away)$/.test(lower) || this.sameTeam(value, awayTeam)) return { selectionKey: 'AWAY_WIN' };
    }
    if (marketId === 'DOUBLE_CHANCE') {
      if (/^(home\s*\/\s*draw|home draw|home or draw|1x|1\/x)$/.test(lower)) return { selectionKey: 'HOME_OR_DRAW' };
      if (/^(draw\s*\/\s*away|draw away|draw or away|x2|x\/2)$/.test(lower)) return { selectionKey: 'DRAW_OR_AWAY' };
      if (/^(home\s*\/\s*away|home away|home or away|12|1\/2)$/.test(lower)) return { selectionKey: 'HOME_OR_AWAY' };
    }
    if (marketId === 'DRAW_NO_BET') {
      if (/^(home|home win|1)$/.test(lower) || this.sameTeam(value, homeTeam)) return { selectionKey: 'HOME_DNB' };
      if (/^(away|away win|2)$/.test(lower) || this.sameTeam(value, awayTeam)) return { selectionKey: 'AWAY_DNB' };
    }
    if (marketId === 'BOTH_TEAMS_TO_SCORE') {
      if (/^(yes|y|gg|both yes)$/.test(lower)) return { selectionKey: 'YES' };
      if (/^(no|n|ng|both no)$/.test(lower)) return { selectionKey: 'NO' };
    }
    if (marketId === 'ASIAN_HANDICAP') {
      const match = value.match(/([+-]?\d+(?:\.\d+)?)\s*\)?$/);
      if (!match || match.index === undefined) return null;
      const prefix = value.slice(0, match.index).replace(/[()]/g, ' ').trim();
      const side = /\bhome\b/i.test(prefix) || this.sameTeam(prefix, homeTeam)
        ? 'HOME'
        : /\baway\b/i.test(prefix) || this.sameTeam(prefix, awayTeam)
          ? 'AWAY'
          : null;
      if (!side) return null;
      const line = Number(match[1]);
      return Number.isFinite(line) ? { selectionKey: `${side}_${canonicalLineSlug(line)}`, line } : null;
    }
    if (this.isOverUnderMarket(marketId)) {
      const match = value.match(/\b(over|under)\s*([0-9]+(?:\.[0-9]+)?)/i);
      if (!match) return null;
      const line = Number(match[2]);
      return Number.isFinite(line)
        ? { selectionKey: `${match[1].toUpperCase()}_${canonicalLineSlug(line)}`, line }
        : null;
    }
    return null;
  }

  private mapOddsApiSelection(
    marketId: string,
    outcome: OddsApiOutcome,
    homeTeam: string,
    awayTeam: string,
  ): { selectionKey: string; line?: number } | null {
    if (marketId === 'MATCH_RESULT') {
      if (this.sameTeam(outcome.name, homeTeam)) return { selectionKey: 'HOME_WIN' };
      if (this.sameTeam(outcome.name, awayTeam)) return { selectionKey: 'AWAY_WIN' };
      if (/^draw$/i.test(outcome.name.trim())) return { selectionKey: 'DRAW' };
    }
    if (marketId === 'BOTH_TEAMS_TO_SCORE') {
      if (/^yes$/i.test(outcome.name.trim())) return { selectionKey: 'YES' };
      if (/^no$/i.test(outcome.name.trim())) return { selectionKey: 'NO' };
    }
    if (marketId === 'DOUBLE_CHANCE' || marketId === 'DRAW_NO_BET') {
      return this.mapSelection(marketId, outcome.name, homeTeam, awayTeam);
    }
    if (marketId === 'ASIAN_HANDICAP') {
      const line = this.finiteNumber(outcome.point);
      if (line === null) return null;
      const side = this.sameTeam(outcome.name, homeTeam) ? 'HOME' : this.sameTeam(outcome.name, awayTeam) ? 'AWAY' : null;
      if (!side) return null;
      return { selectionKey: `${side}_${canonicalLineSlug(line)}`, line };
    }
    if (this.isOverUnderMarket(marketId)) {
      const line = this.finiteNumber(outcome.point);
      if (line === null) return null;
      const side = /^over$/i.test(outcome.name.trim()) ? 'OVER' : /^under$/i.test(outcome.name.trim()) ? 'UNDER' : null;
      if (!side) return null;
      return { selectionKey: `${side}_${canonicalLineSlug(line)}`, line };
    }
    return null;
  }

  /**
   * Provider-market fair odds are computed by removing the overround per
   * bookmaker, then taking the median fair probability across complete books.
   * This only applies to exhaustive result/OU/DNB/BTTS markets; overlapping
   * double-chance selections are deliberately not normalized as one market.
   */
  private calculateMarketFairOdds(quotes: InternalQuote[]): InternalQuote[] {
    const bookmakerGroups = new Map<string, InternalQuote[]>();
    for (const quote of quotes) {
      const fairGroup = this.marketFairGroup(quote);
      if (!fairGroup) continue;
      const key = `${quote.eventId}:${quote.provider}:${fairGroup}:${quote.bookmakerKey}`;
      const list = bookmakerGroups.get(key) ?? [];
      list.push(quote);
      bookmakerGroups.set(key, list);
    }

    const fairProbabilities = new Map<string, number[]>();
    for (const items of bookmakerGroups.values()) {
      const first = items[0];
      const group = this.marketFairGroup(first);
      if (!group) continue;
      const marketId = first.marketId;
      const available = new Map<string, InternalQuote>();
      for (const quote of items) {
        const current = available.get(quote.selectionKey);
        if (!current || quote.decimalOdds > current.decimalOdds) available.set(quote.selectionKey, quote);
      }
      const required = this.requiredFairSelections(marketId, first.line, first.selectionKey);
      if (!required || required.some((selection) => !available.has(selection))) continue;
      const implied = required.map((selection) => 1 / available.get(selection)!.decimalOdds);
      const total = implied.reduce((sum, value) => sum + value, 0);
      if (!Number.isFinite(total) || total <= 0) continue;
      required.forEach((selection, index) => {
        const probability = implied[index] / total;
        const key = `${first.eventId}:${first.provider}:${group}:${selection}`;
        const values = fairProbabilities.get(key) ?? [];
        values.push(probability);
        fairProbabilities.set(key, values);
      });
    }

    return quotes.map((quote) => {
      const group = this.marketFairGroup(quote);
      if (!group) return quote;
      const key = `${quote.eventId}:${quote.provider}:${group}:${quote.selectionKey}`;
      const values = fairProbabilities.get(key);
      if (!values?.length) return quote;
      const probability = this.median(values);
      if (!(probability > 0) || !Number.isFinite(probability)) return quote;
      return { ...quote, marketFairOdds: Number((1 / probability).toFixed(4)) };
    });
  }

  private marketFairGroup(quote: InternalQuote): string | null {
    if (quote.marketId === 'DOUBLE_CHANCE') return null;
    let line: string | undefined;
    if (quote.marketId === 'ASIAN_HANDICAP' && quote.line !== undefined) {
      const homeLine = quote.selectionKey.startsWith('AWAY_') ? -quote.line : quote.line;
      line = canonicalLineSlug(homeLine);
    } else if (quote.line !== undefined) {
      line = canonicalLineSlug(quote.line);
    }
    return `${quote.marketId}:${line ?? '-'}`;
  }

  private requiredFairSelections(marketId: string, line?: number, selectionKey?: string): string[] | null {
    if (marketId === 'MATCH_RESULT' || marketId === 'HALF_TIME_RESULT') return ['HOME_WIN', 'DRAW', 'AWAY_WIN'];
    if (marketId === 'BOTH_TEAMS_TO_SCORE') return ['YES', 'NO'];
    if (marketId === 'DRAW_NO_BET') return ['HOME_DNB', 'AWAY_DNB'];
    if (this.isOverUnderMarket(marketId) && line !== undefined) {
      return [`OVER_${canonicalLineSlug(line)}`, `UNDER_${canonicalLineSlug(line)}`];
    }
    if (marketId === 'ASIAN_HANDICAP' && line !== undefined) {
      const homeLine = selectionKey?.startsWith('AWAY_') ? -line : line;
      return [`HOME_${canonicalLineSlug(homeLine)}`, `AWAY_${canonicalLineSlug(-homeLine)}`];
    }
    return null;
  }

  private isCatalogSelection(marketId: string, selectionKey: string, line?: number): boolean {
    const market = FOOTBALL_MARKET_BY_ID.get(marketId);
    if (!market) return false;
    if (market.selectionMode === 'STATIC') return market.selections.some((selection) => selection.key === selectionKey);
    if (line === undefined || !market.lines?.includes(line)) return false;
    if (market.selectionMode === 'ASIAN_HANDICAP') return selectionKey.startsWith('HOME_') || selectionKey.startsWith('AWAY_');
    return selectionKey.startsWith('OVER_') || selectionKey.startsWith('UNDER_');
  }

  private isOverUnderMarket(marketId: string): boolean {
    return FOOTBALL_MARKET_BY_ID.get(marketId)?.selectionMode === 'OVER_UNDER';
  }

  private priorityRank(slug: string): number {
    const priority = getPriorityCompetition(slug)?.priority;
    if (priority === CompetitionPriority.ELITE) return 0;
    if (priority === CompetitionPriority.HIGH) return 1;
    if (priority === CompetitionPriority.REGIONAL) return 2;
    return 3;
  }

  private teamName(fixture: any, side: 'home' | 'away'): string {
    const payload = fixture.payload ?? {};
    const competitions = Array.isArray(payload.competitions) ? payload.competitions : [];
    const competition = competitions[0] ?? {};
    const competitors = Array.isArray(competition.competitors) ? competition.competitors : [];
    const competitor = competitors.find((item: any) => String(item.homeAway).toLowerCase() === side) ?? competitors[side === 'home' ? 0 : 1];
    return String(competitor?.team?.displayName ?? competitor?.team?.name ?? competitor?.team?.shortDisplayName ?? fixture[side === 'home' ? 'homeTeamId' : 'awayTeamId'] ?? '');
  }

  private sameTeamPair(homeA: string, awayA: string, homeB: string, awayB: string): boolean {
    return this.sameTeam(homeA, homeB) && this.sameTeam(awayA, awayB);
  }

  private sameTeam(a: string, b: string): boolean {
    const one = this.normalizeTeamName(a);
    const two = this.normalizeTeamName(b);
    if (!one || !two) return false;
    if (one === two) return true;
    const aliases: Record<string, string> = {
      'man united': 'manchester united',
      'man utd': 'manchester united',
      'man city': 'manchester city',
      'wolves': 'wolverhampton wanderers',
      'spurs': 'tottenham hotspur',
      'newcastle': 'newcastle united',
      'inter': 'inter milan',
      'internazionale': 'inter milan',
      'psg': 'paris saint germain',
      'paris sg': 'paris saint germain',
      'atletico': 'atletico madrid',
      'bayern munchen': 'bayern munich',
      'athletic club': 'athletic bilbao',
      'athletic': 'athletic bilbao',
      'tottenham': 'tottenham hotspur',
      'brighton': 'brighton and hove albion',
      'west ham': 'west ham united',
      'nottingham forest': 'nottingham forest',
      'leicester': 'leicester city',
    };
    const canonicalOne = aliases[one] ?? one;
    const canonicalTwo = aliases[two] ?? two;
    if (canonicalOne === canonicalTwo) return true;
    return this.tokenDiceSimilarity(canonicalOne, canonicalTwo) >= 0.92;
  }

  private normalizeTeamName(value: string): string {
    let normalized = String(value ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    normalized = normalized
      .replace(/\b(football club|soccer club|fc|afc|cf|sc|cfc|club)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return normalized;
  }

  private tokenDiceSimilarity(a: string, b: string): number {
    if (a === b) return 1;
    if (a.length < 5 || b.length < 5) return 0;
    const make = (value: string) => {
      const padded = `  ${value}  `;
      const set = new Set<string>();
      for (let i = 0; i < padded.length - 2; i += 1) set.add(padded.slice(i, i + 3));
      return set;
    };
    const left = make(a);
    const right = make(b);
    let overlap = 0;
    for (const item of left) if (right.has(item)) overlap += 1;
    return (2 * overlap) / (left.size + right.size);
  }



  private parseDecimalOdds(value: unknown): number | null {
    const odds = typeof value === 'number' ? value : Number(String(value ?? '').trim());
    return Number.isFinite(odds) && odds >= 1.01 && odds <= 100_000 ? Number(odds.toFixed(4)) : null;
  }

  private finiteNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'string' || !value.trim()) return null;
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }

  private toDate(value: unknown): Date | null {
    if (value instanceof Date && Number.isFinite(value.getTime())) return value;
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  private latestDate(...values: Array<Date | null | undefined>): Date | null {
    const dates = values.filter((value): value is Date => Boolean(value) && Number.isFinite((value as Date).getTime()));
    if (!dates.length) return null;
    return new Date(Math.max(...dates.map((value) => value.getTime())));
  }

  private slug(value: unknown): string {
    return String(value ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  }

  private setLatest(map: Map<string, Date>, key: string, date: Date): void {
    const current = map.get(key);
    if (!current || current.getTime() < date.getTime()) map.set(key, date);
  }

  private rotateKeys(keys: string[], cursor?: string): string[] {
    if (!keys.length || !cursor) return keys;
    const index = keys.indexOf(cursor);
    if (index < 0) return keys;
    return [...keys.slice(index + 1), ...keys.slice(0, index + 1)];
  }

  private median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }
}


