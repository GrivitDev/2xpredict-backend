import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import type { SportsFixtureCompetitor, SportsFixtureRecord } from '../interfaces/sports-domain.interface';
import { EspnV2Client } from '../providers/espn-v2.client';
import { SportsNewsArticle } from '../schemas/domain/sports-news-article.schema';

/** ESPN Site News collector. Story metadata and category tags are retained. */
@Injectable()
export class SportsNewsCollectionService {
  private readonly logger = new Logger(SportsNewsCollectionService.name);

  constructor(
    private readonly espn: EspnV2Client,
    @InjectModel(SportsNewsArticle.name) private readonly articleModel: Model<any>,
  ) {}

  async collectSoccerNews(): Promise<{ received: number; saved: number; pages: number }> {
    await this.pruneExpiredNews();
    const pageSize = 50;
    const maximumPages = 100;
    const articles = new Map<string, Record<string, any>>();
    let pages = 0;
    let lastRawPageCount = 0;

    for (let page = 0; page < maximumPages; page += 1) {
      const offset = page * pageSize;
      const response = await this.espn.getSoccerNews(pageSize, offset);
      const pageArticles = this.extractArticles(response);
      lastRawPageCount = this.countFeedPageItems(response);
      pages += 1;
      for (const article of pageArticles) {
        const key = this.articleIdentity(article);
        articles.set(key, article);
      }

      // Do not use the de-duplicated article count here: breakingNews can
      // repeat entries already present in headlines, making a full page look
      // short and prematurely terminating the offset scan.
      if (lastRawPageCount < pageSize) break;
    }

    if (!articles.size) throw new Error('ESPN Soccer News endpoint returned no recognizable articles array.');
    if (pages === maximumPages && lastRawPageCount >= pageSize) {
      throw new Error(`ESPN Soccer News pagination exceeded ${maximumPages} pages; refusing to report a partial daily collection as complete.`);
    }
    const collected = [...articles.values()];
    const saved = await this.persistArticles(collected, { scope: 'SOCCER', endpoint: '/v1/sports/news?sport=soccer' });
    await this.pruneExpiredNews();
    return { received: collected.length, saved, pages };
  }

  async collectLeagueNews(
    leagueId: string,
    competitionId: string,
    fixtures: SportsFixtureRecord[] = [],
  ): Promise<{ received: number; saved: number; fallbackUsed: boolean; fallbackArticles: number }> {
    await this.pruneExpiredNews();
    const endpoint = `/${leagueId}/news`;
    let directArticles: Record<string, any>[] = [];
    let directError: unknown;
    try {
      directArticles = this.extractArticles(await this.espn.getLeagueNews(leagueId, 100));
      if (!directArticles.length) directError = new Error(`League News returned no recognizable article list for ${leagueId}.`);
    } catch (error) {
      directError = error;
    }

    let saved = 0;
    if (directArticles.length) {
      saved += await this.persistArticles(directArticles, {
        scope: 'LEAGUE', endpoint, competitionId, fixtures,
      });
    }

    if (!fixtures.length) {
      if (directError) throw directError;
      await this.pruneExpiredNews();
      return { received: directArticles.length, saved, fallbackUsed: false, fallbackArticles: 0 };
    }

    const missingFixtures = fixtures.filter((fixture) => !directArticles.some((article) => this.isFixtureRelevant(article, fixture)));
    if (!missingFixtures.length && !directError) {
      return { received: directArticles.length, saved, fallbackUsed: false, fallbackArticles: 0 };
    }

    // Summary.news.articles is used only for fixtures still lacking relevant
    // news in the direct league feed (or when the direct feed failed).
    let fallbackArticlesSaved = 0;
    const fallbackFailures: string[] = [];
    for (const fixture of missingFixtures) {
      try {
        const summary = await this.espn.getMatchSummary(leagueId, fixture.espnEventId);
        const summaryArticles = this.extractArticles(summary).filter((article) => this.isFixtureRelevant(article, fixture));
        if (!summaryArticles.length) continue;
        fallbackArticlesSaved += await this.persistArticles(summaryArticles, {
          scope: 'SUMMARY',
          endpoint: `/${leagueId}/summary?event=${fixture.espnEventId}#news`,
          competitionId,
          fixture,
        });
      } catch (error) {
        fallbackFailures.push(`${fixture.id}: ${this.errorMessage(error)}`);
      }
    }

    if (directError && !fallbackArticlesSaved) {
      throw new Error(`League News failed and Summary fallback found no usable match-related stories. ${this.errorMessage(directError)}${fallbackFailures.length ? ` | ${fallbackFailures.join('; ')}` : ''}`);
    }
    await this.pruneExpiredNews();
    return {
      received: directArticles.length + fallbackArticlesSaved,
      saved: saved + fallbackArticlesSaved,
      fallbackUsed: missingFixtures.length > 0,
      fallbackArticles: fallbackArticlesSaved,
    };
  }

  async getNews(query: {
    competitionId?: string; teamId?: string; scope?: 'SOCCER' | 'LEAGUE' | 'SUMMARY';
    limit?: number; before?: Date;
  }): Promise<unknown[]> {
    const filter: Record<string, unknown> = {};
    const and: Record<string, unknown>[] = [];
    if (query.competitionId) and.push({ $or: [{ competitionId: query.competitionId }, { competitionIds: query.competitionId }] });
    if (query.teamId) and.push({ teamIds: query.teamId });
    if (and.length) filter.$and = and;
    if (query.scope) filter.collectionScopes = query.scope;
    if (query.before) filter.publishedAt = { $lt: query.before };
    return this.articleModel.find(filter).sort({ publishedAt: -1, espnArticleId: -1 }).limit(this.clampLimit(query.limit)).select('-_id -__v -rawPayload').lean().exec();
  }

  async getNewsArticle(articleId: string): Promise<unknown | null> {
    const numericId = /^\d+$/.test(articleId) ? Number(articleId) : undefined;
    return this.articleModel.findOne({ $or: [{ id: articleId }, ...(numericId === undefined ? [] : [{ espnArticleId: numericId }]), { canonicalUrl: articleId }] })
      .select('-_id -__v').lean().exec();
  }

  private extractArticles(value: unknown): Record<string, any>[] {
    const root = this.asRecord(value);
    if (!root) return [];
    const data = this.asRecord(root.data);
    const news = this.asRecord(root.news);
    const dataNews = this.asRecord(data?.news);
    const feed = this.asRecord(root.feed);
    const candidates: unknown[] = [
      root.articles, news?.articles, data?.articles, dataNews?.articles,
      root.headlines, root.breakingNews, feed?.articles, root.items,
    ];
    const collected: Record<string, any>[] = [];
    for (const candidate of candidates) {
      const rows = Array.isArray(candidate)
        ? candidate
        : (() => {
            const nested = this.asRecord(candidate);
            return nested && Array.isArray(nested.items) ? nested.items : [];
          })();
      for (const item of rows) {
        const record = this.asRecord(item);
        if (record) collected.push(record);
      }
    }
    const unique = new Map<string, Record<string, any>>();
    for (const article of collected) unique.set(this.articleIdentity(article), article);
    return [...unique.values()];
  }

  private countFeedPageItems(value: unknown): number {
    const root = this.asRecord(value);
    if (!root) return 0;
    const data = this.asRecord(root.data);
    const feed = this.asRecord(root.feed);
    const candidates = [
      root.headlines, root.articles, root.items,
      data?.headlines, data?.articles, data?.items,
      feed?.headlines, feed?.articles, feed?.items,
    ];
    const counts = candidates.map((candidate) => {
      if (Array.isArray(candidate)) return candidate.length;
      const nested = this.asRecord(candidate);
      return nested && Array.isArray(nested.items) ? nested.items.length : 0;
    });
    return Math.max(0, ...counts);
  }

  private articleIdentity(article: Record<string, any>): string {
    const links = this.asRecord(article.links);
    const api = this.asRecord(links?.api);
    const apiSelf = this.asRecord(api?.self);
    const web = this.asRecord(links?.web);
    return this.readString(
      article.id === undefined ? undefined : String(article.id),
      article.nowId,
      apiSelf?.href,
      web?.href,
      article.url,
      article.link,
    ) ?? JSON.stringify(article);
  }

  private async persistArticles(
    articles: Record<string, any>[],
    context: {
      scope: 'SOCCER' | 'LEAGUE' | 'SUMMARY';
      endpoint: string;
      competitionId?: string;
      fixture?: SportsFixtureRecord;
      fixtures?: SportsFixtureRecord[];
    },
  ): Promise<number> {
    let saved = 0;
    for (const article of articles) {
      const espnId = this.toNumber(article.id);
      const links = this.asRecord(article.links) ?? {};
      const apiUrl = this.readString(this.asRecord(this.asRecord(links.api)?.self)?.href);
      const canonicalUrl = this.readString(this.asRecord(links.web)?.href, article.url, article.link);
      const id = espnId !== undefined
        ? `espn-news:${espnId}`
        : `espn-news:url:${createHash('sha256').update(canonicalUrl ?? JSON.stringify(article)).digest('hex')}`;
      const categories = this.readArray(article.categories).map((item) => this.asRecord(item)).filter((item): item is Record<string, any> => Boolean(item));
      const teamIds = categories.filter((item) => String(item.type).toLowerCase() === 'team')
        .map((item) => this.toNumber(item.teamId ?? this.asRecord(item.team)?.id)).filter((item): item is number => item !== undefined).map((item) => `team:${item}`);
      const athleteIds = categories.filter((item) => String(item.type).toLowerCase() === 'athlete')
        .map((item) => this.toNumber(item.athleteId ?? this.asRecord(item.athlete)?.id)).filter((item): item is number => item !== undefined).map((item) => `athlete:${item}`);
      const competitionSlugs = new Set<string>();
      for (const category of categories) {
        const categoryType = String(category.type ?? '').toLowerCase();
        if (categoryType === 'league') {
          const league = this.asRecord(category.league) ?? {};
          const leagueLinks = this.asRecord(league.links);
          const webLinks = this.asRecord(leagueLinks?.web);
          const mobileLinks = this.asRecord(leagueLinks?.mobile);
          const webLeague = this.asRecord(webLinks?.leagues);
          const mobileLeague = this.asRecord(mobileLinks?.leagues);
          const href = this.readString(webLeague?.href, mobileLeague?.href);
          const slug = href?.match(/\/name\/([^/?]+)/)?.[1]
            ?? this.readString(league.slug, league.abbreviation, category.slug);
          if (slug && slug.toLowerCase() !== 'soccer') competitionSlugs.add(slug.toLowerCase());
        }
        if (categoryType === 'event') {
          const event = this.asRecord(category.event) ?? {};
          const leagueRef = event.league;
          const league = this.asRecord(leagueRef);
          const slug = typeof leagueRef === 'string'
            ? leagueRef
            : this.readString(league?.slug, league?.abbreviation, league?.name);
          if (slug && slug.toLowerCase() !== 'soccer') competitionSlugs.add(slug.toLowerCase());
        }
      }
      const competitionIds = [...competitionSlugs].map((slug) => `competition:${slug}`);
      const fixtureCandidates = context.fixtures ?? (context.fixture ? [context.fixture] : []);
      const fixtureIds = fixtureCandidates
        .filter((fixture) => this.isFixtureRelevant(article, fixture))
        .map((fixture) => fixture.id);
      const images = this.readArray(article.images).map((item) => this.asRecord(item)).filter((item): item is Record<string, any> => Boolean(item) && Boolean(this.readString((item as any).url)))
        .map((item) => ({ id: item.id, type: item.type, name: item.name, caption: item.caption, alt: item.alt, credit: item.credit, width: this.toNumber(item.width), height: this.toNumber(item.height), url: String(item.url) }));
      const existing = await this.articleModel.findOne({
        $or: [{ id }, ...(canonicalUrl ? [{ canonicalUrl }] : [])],
      }).lean().exec();
      const publishedAt = this.toDate(article.published, article.publishedAt, article.date, existing?.publishedAt);
      const retentionCutoff = Date.now() - 30 * 24 * 60 * 60_000;
      if (publishedAt && publishedAt.getTime() < retentionCutoff) continue;
      const expiresAt = new Date((publishedAt ?? new Date()).getTime() + 30 * 24 * 60 * 60_000);
      const union = (...groups: unknown[][]): string[] => [...new Set(groups.flat().filter((item): item is string => typeof item === 'string' && Boolean(item.trim())))];
      const existingCategories = Array.isArray(existing?.categories) ? existing.categories : [];
      const categoryMap = new Map<string, Record<string, any>>();
      for (const category of [...existingCategories, ...categories]) {
        const row = this.asRecord(category);
        if (!row) continue;
        const key = `${String(row.type ?? '')}:${String(row.id ?? row.guid ?? row.description ?? JSON.stringify(row))}`;
        categoryMap.set(key, row);
      }
      const existingImages = Array.isArray(existing?.images) ? existing.images : [];
      const imageMap = new Map<string, Record<string, any>>();
      for (const image of [...existingImages, ...images]) {
        const row = this.asRecord(image);
        if (!row || typeof row.url !== 'string') continue;
        imageMap.set(row.url, row);
      }
      const collectionScopes = union(existing?.collectionScopes ?? (existing?.collectionScope ? [existing.collectionScope] : []), [context.scope]) as Array<'SOCCER' | 'LEAGUE' | 'SUMMARY'>;
      const payload = {
        id,
        espnArticleId: espnId ?? existing?.espnArticleId,
        nowId: this.readString(article.nowId, existing?.nowId),
        contentKey: this.readString(article.contentKey, existing?.contentKey),
        headline: this.readString(article.headline, article.title, existing?.headline) ?? 'Untitled ESPN story',
        description: this.readString(article.description, article.summary, existing?.description),
        type: this.readString(article.type, existing?.type),
        publishedAt,
        expiresAt,
        lastModifiedAt: this.toDate(article.lastModified, article.updatedAt, existing?.lastModifiedAt),
        byline: this.readString(article.byline, existing?.byline),
        images: [...imageMap.values()],
        categories: [...categoryMap.values()],
        canonicalUrl: canonicalUrl ?? existing?.canonicalUrl,
        apiUrl: apiUrl ?? existing?.apiUrl,
        mobileUrl: this.readString(this.asRecord(links.mobile)?.href, existing?.mobileUrl),
        premium: article.premium === undefined ? Boolean(existing?.premium) : Boolean(article.premium),
        collectionScope: context.scope === 'SUMMARY' || context.scope === 'LEAGUE' ? context.scope : (existing?.collectionScope ?? context.scope),
        collectionScopes,
        competitionId: context.competitionId ?? existing?.competitionId,
        competitionIds: union(existing?.competitionIds ?? [], context.competitionId ? [context.competitionId] : [], competitionIds),
        teamIds: union(existing?.teamIds ?? [], teamIds),
        athleteIds: union(existing?.athleteIds ?? [], athleteIds),
        fixtureIds: union(existing?.fixtureIds ?? [], fixtureIds),
        source: { provider: 'ESPN', endpoint: context.endpoint, collectedAt: new Date() },
        rawPayload: article,
      };
      if (existing?._id) {
        await this.articleModel.updateOne({ _id: existing._id }, { $set: payload }).exec();
      } else {
        try {
          await this.articleModel.create(payload);
        } catch (error) {
          if (!this.isDuplicateKey(error)) throw error;
          const duplicateFilter = canonicalUrl ? { canonicalUrl } : { id };
          await this.articleModel.updateOne(duplicateFilter, { $set: payload }).exec();
        }
      }
      saved += 1;
    }
    return saved;
  }

  private async pruneExpiredNews(): Promise<void> {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60_000);
    await this.articleModel.deleteMany({
      $or: [
        { expiresAt: { $lte: new Date() } },
        { expiresAt: { $exists: false }, publishedAt: { $lt: cutoff } },
      ],
    }).exec();
  }

  private isFixtureRelevant(article: Record<string, any>, fixture: SportsFixtureRecord): boolean {
    const home = fixture.competitors.find((item) => item.homeAway === 'HOME');
    const away = fixture.competitors.find((item) => item.homeAway === 'AWAY');
    if (!home || !away) return false;
    const homeId = home.teamId.replace(/^team:/, '');
    const awayId = away.teamId.replace(/^team:/, '');
    const categories = this.readArray(article.categories).map((item) => this.asRecord(item)).filter(Boolean) as Record<string, any>[];
    const teamCategoryIds = categories.filter((item) => String(item.type).toLowerCase() === 'team')
      .map((item) => String(item.teamId ?? this.asRecord(item.team)?.id ?? item.id ?? ''));
    const hasHome = teamCategoryIds.includes(homeId);
    const hasAway = teamCategoryIds.includes(awayId);
    const eventTagged = categories.some((item) => String(item.type).toLowerCase() === 'event' && String(item.eventId ?? item.id) === fixture.espnEventId);
    if (eventTagged || hasHome || hasAway) return true;
    const homeName = this.teamName(home).toLowerCase();
    const awayName = this.teamName(away).toLowerCase();
    const text = `${article.headline ?? ''} ${article.description ?? ''}`.toLowerCase();
    return Boolean((homeName && text.includes(homeName)) || (awayName && text.includes(awayName)));
  }

  private teamName(competitor: SportsFixtureCompetitor): string {
    const raw = this.asRecord(competitor.rawPayload) ?? {};
    const team = this.asRecord(raw.team) ?? raw;
    return this.readString(team.displayName, team.name, team.shortDisplayName) ?? '';
  }

  private clampLimit(value?: number): number { return !Number.isFinite(value) ? 30 : Math.max(1, Math.min(100, Math.floor(Number(value)))); }
  private isDuplicateKey(error: unknown): boolean { return Boolean(error && typeof error === 'object' && (error as any).code === 11000); }
  private asRecord(value: unknown): Record<string, any> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null; }
  private readArray(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
  private readString(...values: unknown[]): string | undefined { for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim(); return undefined; }
  private toNumber(value: unknown): number | undefined { if (typeof value === 'number' && Number.isFinite(value)) return value; if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value); return undefined; }
  private toDate(...values: unknown[]): Date | undefined { for (const value of values) { if (typeof value !== 'string' && !(value instanceof Date)) continue; const date = new Date(value); if (!Number.isNaN(date.getTime())) return date; } return undefined; }
  private errorMessage(error: unknown): string { return error instanceof Error ? error.message.replace(/[\r\n]+/g, ' ').slice(0, 220) : String(error).slice(0, 220); }
}

