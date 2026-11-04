import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { EspnFixture } from '../../sports/schemas/espn/espn-fixture.schema';
import { EspnTeam } from '../../sports/schemas/espn/espn-team.schema';
import { EspnStanding } from '../../sports/schemas/espn/espn-standing.schema';
import {
  PredictionFixtureCore,
  PredictionMatchContext,
  PredictionTeamCore,
} from '../interfaces/espn-prediction-context.interface';
import { EspnPayloadUtil } from '../utils/espn-payload.util';
import { PREDICTION_ENGINE_CONFIG } from '../config/prediction-engine.config';
import { OddsReadService } from '../../odds/services/odds-read.service';

@Injectable()
export class PredictionDataService {
  private readonly logger = new Logger(PredictionDataService.name);

  constructor(
    @InjectModel(EspnFixture.name)
    private readonly fixtureModel: Model<EspnFixture>,
    @InjectModel(EspnTeam.name)
    private readonly teamModel: Model<EspnTeam>,
    @InjectModel(EspnStanding.name)
    private readonly standingModel: Model<EspnStanding>,
    private readonly oddsService: OddsReadService,
  ) {}

  async loadForPrediction(eventId: string): Promise<PredictionMatchContext> {
    const normalizedEventId = String(eventId ?? '').trim();
    if (!normalizedEventId)
      throw new NotFoundException('An ESPN event ID is required.');

    const raw = await this.fixtureModel
      .findOne({ eventId: normalizedEventId })
      .select({
        _id: 0,
        eventId: 1,
        leagueId: 1,
        season: 1,
        fixtureDate: 1,
        live: 1,
        completed: 1,
        status: 1,
        statusDetail: 1,
        statusShortDetail: 1,
        homeTeamId: 1,
        awayTeamId: 1,
        homeScore: 1,
        awayScore: 1,
        collectedAt: 1,
        'payload.name': 1,
        'payload.shortName': 1,
        'payload.competitions.competitors': 1,
        'payload.competitions.odds': 1,
        'payload.competitions.details.athletesInvolved': 1,
        'payload.competitions.details.type': 1,
        'payload.summary.pickcenter': 1,
        'payload.summary.odds': 1,
        'payload.summary.seasonseries': 1,
        'payload.summary.lastFiveGames': 1,
        'payload.summary.rosters': 1,
        'payload.summary.leaders': 1,
        'payload.summary.boxscore': 1,
        'payload.summary.keyEvents': 1,
        'payload.summary.meta': 1,
        'payload.summary.header.competitions.competitors': 1,
        'payload.summaryCollectedAt': 1,
      })
      .lean()
      .exec();

    if (!raw)
      throw new NotFoundException(
        `ESPN fixture ${normalizedEventId} was not found.`,
      );

    const fixture = this.toFixtureCore(raw);
    const fixtureStatus = [
      fixture.status,
      (raw as unknown as Record<string, unknown>).statusDetail,
      (raw as unknown as Record<string, unknown>).statusShortDetail,
    ].filter(Boolean).map(String).join(' ');
    const isUnavailable = fixture.completed === true
      || /(^|[^A-Z])(FINAL|FINISHED|FULL[ _-]?TIME|STATUS_FINAL|AFTER EXTRA TIME|AFTER PENALTIES|FT|AET|PEN)([^A-Z]|$)/i.test(fixtureStatus)
      || /postpon|\bpst\b|cancel|\bcanc\b|abandon|suspend|interrupt|delay|no[_ -]?contest/i.test(fixtureStatus);
    if (isUnavailable) {
      throw new UnprocessableEntityException(
        'Predictions are unavailable for a completed, postponed, cancelled, or otherwise unavailable fixture.',
      );
    }
    // Kickoff time and live state do not block prediction generation. Each
    // market selection is still checked against the Odds module's exact quote.


    const payload = EspnPayloadUtil.asRecord(
      (raw as unknown as Record<string, unknown>).payload,
    );
    const summary = EspnPayloadUtil.asRecord(payload.summary);
    const summaryAvailable = Object.keys(summary).length > 0;

    // Summary is a valuable feature source, not a hard dependency. When ESPN
    // omits it, the model can still use canonical fixture data, completed-match
    // history, league results, standings, and persisted Odds-module prices.
    // A specialised market model may use a clearly labelled Odds-implied fallback
    // when its statistics are missing; it must not invent a bookmaker quote.
    if (!summaryAvailable) {
      this.logger.warn(
        `ESPN Summary is unavailable for fixture ${normalizedEventId}; using only independently available fixture, historical, standings, and persisted odds evidence.`,
      );
    }

    // OddsWorkerService is the single owner of provider refreshes. Prediction
    // runs consume the persisted Odds-module snapshot after the queue's readiness
    // check instead of issuing a second provider refresh for every fixture.
    const [
      teamDocs,
      historicalRaw,
      leagueRaw,
      storedOddsRaw,
      standingsRaw,
    ] = await Promise.all([
      this.teamModel
        .find({
          leagueId: fixture.leagueId,
          teamId: { $in: [fixture.homeTeamId, fixture.awayTeamId] },
        })
        .select({
          _id: 0,
          teamId: 1,
          name: 1,
          displayName: 1,
          shortDisplayName: 1,
          abbreviation: 1,
          logo: 1,
        })
        .lean()
        .exec(),
      this.fixtureModel
        .find({
          fixtureDate: { $lt: fixture.fixtureDate },
          completed: true,
          $or: [
            { homeTeamId: { $in: [fixture.homeTeamId, fixture.awayTeamId] } },
            { awayTeamId: { $in: [fixture.homeTeamId, fixture.awayTeamId] } },
          ],
        })
        .select({
          _id: 0,
          eventId: 1,
          leagueId: 1,
          season: 1,
          fixtureDate: 1,
          live: 1,
          completed: 1,
          status: 1,
          homeTeamId: 1,
          awayTeamId: 1,
          homeScore: 1,
          awayScore: 1,
          collectedAt: 1,
          'payload.competitions.competitors': 1,
          'payload.competitions.details': 1,
          'payload.summary.boxscore': 1,
          'payload.summary.keyEvents': 1,
          'payload.summary.rosters': 1,
        })
        .sort({ fixtureDate: -1 })
        .limit(160)
        .lean()
        .exec(),
      this.fixtureModel
        .find({
          leagueId: fixture.leagueId,
          fixtureDate: { $lt: fixture.fixtureDate },
          completed: true,
        })
        .select({
          _id: 0,
          eventId: 1,
          leagueId: 1,
          fixtureDate: 1,
          homeTeamId: 1,
          awayTeamId: 1,
          homeScore: 1,
          awayScore: 1,
          completed: 1,
          'payload.summary.boxscore': 1,
          'payload.competitions.competitors.id': 1,
          'payload.competitions.competitors.team.id': 1,
          'payload.competitions.competitors.homeAway': 1,
          'payload.competitions.competitors.statistics': 1,
          'payload.competitions.details': 1,
        })
        .sort({ fixtureDate: -1 })
        .limit(360)
        .lean()
        .exec(),
      this.oddsService.getFixturePrices(normalizedEventId),
      this.standingModel
        .findOne({
          leagueId: fixture.leagueId.trim().toLowerCase(),
          season: fixture.season,
        })
        .select({ _id: 0, leagueId: 1, season: 1, payload: 1, fetchedAt: 1 })
        .lean()
        .exec(),
    ]);

    const homeTeam = this.resolveTeam(
      fixture.homeTeamId,
      fixture.leagueId,
      payload,
      summary,
      'home',
      teamDocs,
    );
    const awayTeam = this.resolveTeam(
      fixture.awayTeamId,
      fixture.leagueId,
      payload,
      summary,
      'away',
      teamDocs,
    );

    // Do not substitute the fixture document's collection time for the ESPN
    // summary timestamp. When Summary freshness cannot be proven, confidence
    // calculation treats it as unknown; historical fixture evidence has its own sample assessment.
    const summaryCollectedAt =
      EspnPayloadUtil.toValidDate(payload.summaryCollectedAt) ??
      EspnPayloadUtil.toValidDate(
        EspnPayloadUtil.asRecord(summary.meta).lastUpdatedAt,
      );

    const summaryAgeHours = summaryCollectedAt
      ? Math.max(0, (Date.now() - summaryCollectedAt.getTime()) / 3_600_000)
      : null;

    const hasPickCenter = this.hasMeaningfulValue(summary.pickcenter);
    const usableOdds = (storedOddsRaw as any[]).some((quote) => {
      const freshnessOkay = quote?.isFresh === true;
      return quote?.priceType === 'PROVIDER'
        && quote?.oddsBasis === 'BOOKMAKER_ONLY'
        && Number.isFinite(Number(quote?.decimalOdds))
        && Number(quote.decimalOdds) > 1
        && freshnessOkay;
    });
    const historyFixtures = historicalRaw.map((item: any) => this.toFixtureCore(item));
    const hasOdds = usableOdds;
    const hasHeadToHead = this.hasUsableHeadToHead(
      fixture.homeTeamId, fixture.awayTeamId, fixture.fixtureDate, historyFixtures, summary,
    );
    const hasLastFive = this.hasUsableTeamForm(
      fixture.homeTeamId, fixture.awayTeamId, fixture.fixtureDate, historyFixtures, summary,
    );
    const standingsPayload = standingsRaw?.payload
      ? EspnPayloadUtil.asRecord(standingsRaw.payload)
      : null;
    const hasStandings = this.hasUsableStandingsPayload(standingsPayload);
    const hasRosters = this.hasMeaningfulValue(summary.rosters);

    const context: PredictionMatchContext = {
      fixture: {
        ...fixture,
        summaryCollectedAt: summaryCollectedAt ?? null,
      },
      summary,
      summaryAvailable,
      standingsPayload,
      standingsFetchedAt:
        EspnPayloadUtil.toValidDate(standingsRaw?.fetchedAt) ?? null,
      storedOdds: (storedOddsRaw as any[]).map((quote) => ({
        marketId: String(quote.marketId),
        selectionKey: String(quote.selectionKey),
        ...(quote.line !== undefined && quote.line !== null && Number.isFinite(Number(quote.line)) ? { line: Number(quote.line) } : {}),
        decimalOdds: Number(quote.decimalOdds),
        predictionReady: quote.predictionReady === true,
        priceType: quote.priceType === 'PROVIDER' ? 'PROVIDER' as const : 'ESTIMATED' as const,
        provider: quote.provider === 'ESPN' || quote.provider === 'THE_ODDS_API' ? quote.provider : null,
        bookmaker: typeof quote.bookmaker === 'string' ? quote.bookmaker : null,
        providerUpdatedAt: EspnPayloadUtil.toValidDate(quote.providerUpdatedAt),
        isFresh: quote.isFresh === true,
        fairOdds: Number.isFinite(Number(quote.fairOdds)) ? Number(quote.fairOdds) : null,
        oddsBasis: ['BOOKMAKER_ONLY', 'BOOKMAKER_PLUS_HISTORY', 'HISTORICAL_ONLY', 'PRIOR_ONLY'].includes(String(quote.oddsBasis)) ? quote.oddsBasis : null,
        oddsCalculationMethod: typeof quote.oddsCalculationMethod === 'string' ? quote.oddsCalculationMethod : null,
        updatedAt: EspnPayloadUtil.toValidDate(quote.updatedAt),
      })),
      homeTeam,
      awayTeam,
      historicalFixtures: historyFixtures,
      leagueFixtures: leagueRaw.map((item: any) => this.toFixtureCore(item)),
      loadedAt: new Date(),
      hasOdds,
      hasPickCenter,
      hasHeadToHead,
      hasLastFive,
      hasStandings,
      hasRosters,
      summaryAgeHours,
    };

    return context;
  }

  private resolveTeam(
    teamId: string,
    leagueId: string,
    payload: Record<string, any>,
    summary: Record<string, any>,
    side: 'home' | 'away',
    docs: unknown[],
  ): PredictionTeamCore {
    const allCompetitors: unknown[] = [
      ...(EspnPayloadUtil.asArray(payload.competitions) as unknown[]).flatMap(
        (competition): unknown[] =>
          EspnPayloadUtil.asArray(
            EspnPayloadUtil.asRecord(competition).competitors,
          ) as unknown[],
      ),
      ...(
        EspnPayloadUtil.asArray(
          EspnPayloadUtil.asRecord(summary.header).competitions,
        ) as unknown[]
      ).flatMap(
        (competition): unknown[] =>
          EspnPayloadUtil.asArray(
            EspnPayloadUtil.asRecord(competition).competitors,
          ) as unknown[],
      ),
    ];
    const competitor = allCompetitors.find(
      (candidate) =>
        String(EspnPayloadUtil.asRecord(candidate).id ?? '') === teamId ||
        String(
          EspnPayloadUtil.asRecord(EspnPayloadUtil.asRecord(candidate).team)
            .id ?? '',
        ) === teamId,
    );
    const competitorRecord = EspnPayloadUtil.asRecord(competitor);
    const payloadTeam = EspnPayloadUtil.asRecord(competitorRecord.team);
    const saved = EspnPayloadUtil.asRecord(
      docs.find(
        (team) =>
          String(EspnPayloadUtil.asRecord(team).teamId ?? '') === teamId,
      ),
    );
    return {
      id: teamId,
      name:
        EspnPayloadUtil.firstNonEmpty(
          payloadTeam.displayName,
          payloadTeam.name,
          payloadTeam.shortDisplayName,
          saved?.displayName,
          saved?.name,
        ) ?? `${side === 'home' ? 'Home' : 'Away'} Team`,
      abbreviation: EspnPayloadUtil.firstNonEmpty(
        payloadTeam.abbreviation,
        saved?.abbreviation,
      ),
      logo: EspnPayloadUtil.firstNonEmpty(payloadTeam.logo, saved?.logo),
    };
  }

  private toFixtureCore(raw: any): PredictionFixtureCore {
    const payload = EspnPayloadUtil.asRecord(
      (raw as Record<string, unknown>).payload,
    );
    // Match lifecycle and live state are owned by root fields persisted by
    // Sports fixture refresh. Summary/detail status is feature data, not a gate.
    const statusParts = [raw.status, raw.statusDetail, raw.statusShortDetail]
      .filter((value) => value !== null && value !== undefined);
    const statusText = statusParts.map(String).join(' ');
    const statusLooksLive = /(^|[^A-Z])(IN[_ -]?PROGRESS|INPROGRESS|LIVE|HALF[_ -]?TIME|FIRST[_ -]?HALF|SECOND[_ -]?HALF|STATUS_HALFTIME|STATUS_IN_PROGRESS)([^A-Z]|$)/i.test(statusText);
    const joinedStatus = [raw.status, raw.statusDetail, raw.statusShortDetail].filter((value) => typeof value === 'string' && value.trim()).join(' ');
    return {
      eventId: String((raw as Record<string, unknown>).eventId),
      leagueId: String((raw as Record<string, unknown>).leagueId),
      season: Number((raw as Record<string, unknown>).season ?? 0),
      fixtureDate: new Date(
        (raw as Record<string, unknown>).fixtureDate as string | number | Date,
      ),
      live: raw.live === true || statusLooksLive,
      completed: raw.completed === true,
      status: String(raw.status ?? 'UNKNOWN'),
      statusDetail: raw.statusDetail ? String(raw.statusDetail) : undefined,
      statusShortDetail: raw.statusShortDetail ? String(raw.statusShortDetail) : undefined,
      homeTeamId: String((raw as Record<string, unknown>).homeTeamId),
      awayTeamId: String((raw as Record<string, unknown>).awayTeamId),
      homeScore:
        EspnPayloadUtil.finiteNumber(
          (raw as Record<string, unknown>).homeScore,
        ) ?? undefined,
      awayScore:
        EspnPayloadUtil.finiteNumber(
          (raw as Record<string, unknown>).awayScore,
        ) ?? undefined,
      collectedAt:
        EspnPayloadUtil.toValidDate(
          (raw as Record<string, unknown>).collectedAt,
        ) ?? new Date(),
      summaryCollectedAt: EspnPayloadUtil.toValidDate(
        payload.summaryCollectedAt,
      ),
      payload,
    };
  }

  private hasUsableStandingsPayload(value: unknown): boolean {
    if (!value) return false;
    const visit = (node: unknown, depth = 0): boolean => {
      if (depth > 12 || !node || typeof node !== 'object') return false;
      const record = node as Record<string, unknown>;
      const standings = record.standings;
      if (standings && typeof standings === 'object' && !Array.isArray(standings)) {
        const entries = (standings as Record<string, unknown>).entries;
        if (Array.isArray(entries) && entries.length > 0) return true;
      }
      const children = record.children;
      return Array.isArray(children) && children.some((child) => visit(child, depth + 1));
    };
    return visit(value);
  }

  private hasUsableTeamForm(
    homeTeamId: string,
    awayTeamId: string,
    kickoff: Date,
    history: PredictionFixtureCore[],
    summary: Record<string, any>,
  ): boolean {
    const hasHistoricalScores = history.some((fixture) =>
      fixture.fixtureDate < kickoff
      && fixture.completed
      && Number.isFinite(fixture.homeScore)
      && Number.isFinite(fixture.awayScore)
      && [homeTeamId, awayTeamId].some((teamId) =>
        fixture.homeTeamId === teamId || fixture.awayTeamId === teamId,
      ),
    );
    if (hasHistoricalScores) return true;

    for (const blockValue of EspnPayloadUtil.asArray(summary.lastFiveGames)) {
      const block = EspnPayloadUtil.asRecord(blockValue);
      const team = EspnPayloadUtil.asRecord(block.team);
      const teamId = String(team.id ?? block.teamId ?? block.id ?? '');
      if (teamId !== homeTeamId && teamId !== awayTeamId) continue;
      for (const eventValue of EspnPayloadUtil.asArray(block.events)) {
        const event = EspnPayloadUtil.asRecord(eventValue);
        const date = EspnPayloadUtil.toValidDate(event.gameDate ?? event.date);
        if (!date || date.getTime() >= kickoff.getTime()) continue;
        if (
          EspnPayloadUtil.finiteNumber(event.homeTeamScore ?? event.homeScore) !== null
          && EspnPayloadUtil.finiteNumber(event.awayTeamScore ?? event.awayScore) !== null
        ) return true;
      }
    }
    return false;
  }

  private hasUsableHeadToHead(
    homeTeamId: string,
    awayTeamId: string,
    kickoff: Date,
    history: PredictionFixtureCore[],
    summary: Record<string, any>,
  ): boolean {
    const historical = history.some((fixture) =>
      fixture.fixtureDate < kickoff
      && fixture.completed
      && Number.isFinite(fixture.homeScore)
      && Number.isFinite(fixture.awayScore)
      && ((fixture.homeTeamId === homeTeamId && fixture.awayTeamId === awayTeamId)
        || (fixture.homeTeamId === awayTeamId && fixture.awayTeamId === homeTeamId)),
    );
    if (historical) return true;

    for (const blockValue of EspnPayloadUtil.asArray(summary.seasonseries)) {
      for (const eventValue of EspnPayloadUtil.asArray(EspnPayloadUtil.asRecord(blockValue).events)) {
        const event = EspnPayloadUtil.asRecord(eventValue);
        const date = EspnPayloadUtil.toValidDate(event.gameDate ?? event.date);
        if (!date || date.getTime() >= kickoff.getTime()) continue;
        const competitors = EspnPayloadUtil.asArray(event.competitors).map((item) => EspnPayloadUtil.asRecord(item));
        const home = competitors.find((item) => item.homeAway === 'home');
        const away = competitors.find((item) => item.homeAway === 'away');
        const eventHomeId = String(EspnPayloadUtil.asRecord(home?.team).id ?? home?.id ?? '');
        const eventAwayId = String(EspnPayloadUtil.asRecord(away?.team).id ?? away?.id ?? '');
        if (!((eventHomeId === homeTeamId && eventAwayId === awayTeamId)
          || (eventHomeId === awayTeamId && eventAwayId === homeTeamId))) continue;
        if (EspnPayloadUtil.finiteNumber(home?.score) !== null && EspnPayloadUtil.finiteNumber(away?.score) !== null) return true;
      }
    }
    return false;
  }

  private hasMeaningfulValue(value: unknown): boolean {
    if (value === null || value === undefined) return false;
    if (Array.isArray(value))
      return value.some((item) => item !== null && item !== undefined);
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return Boolean(value);
  }
}






