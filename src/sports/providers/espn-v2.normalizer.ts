import { Injectable } from '@nestjs/common';

import type {
  SportsCompetitionRecord,
  SportsCompetitionRegion,
  SportsCompetitionType,
  SportsFixtureCompetitor,
  SportsFixturePeriodScore,
  SportsFixtureRecord,
  SportsFixtureState,
  SportsMatchOddsSnapshotRecord,
  SportsMatchTimelineEventRecord,
  SportsOddsBookmaker,
  SportsOddsMarket,
  SportsSeasonRecord,
  SportsSourceMetadata,
  SportsTeamRecord,
} from '../interfaces/sports-domain.interface';
import type { ProviderJsonObject } from '../interfaces/provider-response.interface';

export interface FixtureNormalizationContext {
  leagueId: string;
  competitionId: string;
  seasonId?: string;
  seasonYear?: number;
  collectedAt?: Date;
}

export interface OddsNormalizationContext {
  fixtureId: string;
  leagueId: string;
  eventId: string;
  competitionId: string;
  homeTeam: string;
  awayTeam: string;
  kickoffAt: Date;
  collectedAt?: Date;
}

interface ParsedMarket {
  marketKey: string;
  marketName: string;
  marketId?: string;
  outcomes: SportsOddsMarket['outcomes'];
  providerUpdatedAt?: Date;
}

/**
 * ESPN Soccer normalizer. Every normalized entity retains the complete ESPN
 * source object in `rawPayload`; domain fields are a convenient, stable index
 * over the source and never replace the original provider facts.
 */
@Injectable()
export class EspnV2Normalizer {
  normalizeCompetition(
    value: unknown,
    leagueId: string,
    collectedAt = new Date(),
  ): SportsCompetitionRecord {
    const raw = this.asRecord(value);
    if (!raw)
      throw new Error(
        'ESPN league details response is empty or is not an object.',
      );
    const slug = this.readString(raw.slug, leagueId, raw.abbreviation, raw.id)
      ?.trim()
      .toLowerCase();
    if (!slug)
      throw new Error('ESPN league details did not identify the league.');

    const season =
      this.asRecord(raw.season) ?? this.asRecord(raw.currentSeason) ?? {};
    const year =
      this.readNumber(raw.currentSeasonYear, raw.seasonYear, season.year) ??
      this.yearFromRef(season.$ref);
    const startDate = this.readDate(
      season.startDate,
      season.start,
      raw.currentSeasonStartDate,
    );
    const endDate = this.readDate(
      season.endDate,
      season.end,
      raw.currentSeasonEndDate,
    );
    const competitionId = this.competitionId(slug);
    const country = this.asRecord(raw.country);
    const typeObject = this.asRecord(raw.type);
    const isTournament =
      this.readBoolean(raw.isTournament, typeObject?.tournament) ?? false;

    return {
      id: competitionId,
      espnId: this.readString(raw.id) ?? slug,
      slug,
      name:
        this.readString(
          raw.name,
          raw.displayName,
          raw.shortName,
          raw.abbreviation,
        ) ?? slug,
      displayName: this.readString(raw.displayName, raw.name),
      abbreviation: this.readString(raw.abbreviation, raw.shortName),
      type: this.competitionType(raw, isTournament),
      region: this.competitionRegion(
        country?.name,
        country?.abbreviation,
        slug,
      ),
      country: this.readString(
        country?.name,
        country?.abbreviation,
        raw.countryName,
      ),
      logo: this.readImage(raw.logos, raw.logo),
      isActive: this.readBoolean(raw.active, raw.isActive) ?? true,
      currentSeasonId: year ? this.seasonId(competitionId, year) : undefined,
      currentSeasonYear: year,
      currentSeasonStartDate: startDate,
      currentSeasonEndDate: endDate,
      rawPayload: this.cloneRaw(raw),
      source: this.source(
        `/leagues/${slug}`,
        this.readString(raw.id, slug),
        collectedAt,
        raw,
      ),
      createdAt: collectedAt,
      updatedAt: collectedAt,
    };
  }

  normalizeSeason(
    value: unknown,
    competitionId: string,
    isCurrent = false,
    collectedAt = new Date(),
  ): SportsSeasonRecord {
    const raw = this.asRecord(value);
    if (!raw) throw new Error('ESPN season item is not an object.');
    const year =
      this.readNumber(raw.year, raw.seasonYear, raw.id) ??
      this.yearFromRef(raw.$ref);
    if (!year || year < 1800 || year > 3000)
      throw new Error('ESPN season item does not contain a valid season year.');
    const espnId = this.readString(raw.id, String(year)) ?? String(year);
    return {
      id: this.seasonId(competitionId, year),
      espnId,
      competitionId,
      year,
      displayName: this.readString(raw.displayName, raw.name),
      shortDisplayName: this.readString(raw.shortDisplayName, raw.abbreviation),
      startDate: this.readDate(raw.startDate, raw.start),
      endDate: this.readDate(raw.endDate, raw.end),
      isCurrent:
        isCurrent ||
        (this.readBoolean(raw.isCurrent, raw.current, raw.active) ?? false),
      rawPayload: this.cloneRaw(raw),
      source: this.source(`/seasons/${espnId}`, espnId, collectedAt, raw),
      createdAt: collectedAt,
      updatedAt: collectedAt,
    };
  }

  normalizeTeam(
    value: unknown,
    leagueId: string,
    collectedAt = new Date(),
    endpoint?: string,
  ): SportsTeamRecord {
    const outer = this.asRecord(value);
    const raw = this.asRecord(outer?.team) ?? outer;
    if (!raw)
      throw new Error(
        'ESPN team details response is empty or is not an object.',
      );
    const espnId = this.readEntityId(raw);
    const name = this.readString(
      raw.displayName,
      raw.name,
      raw.shortDisplayName,
      raw.nickname,
    );
    if (!espnId || !name)
      throw new Error('ESPN team details must contain a team ID and name.');
    const country = this.asRecord(raw.country);
    const logo = this.readImage(raw.logos, raw.logo, raw.crest);
    return {
      id: this.teamId(espnId),
      espnId,
      leagueIds: [leagueId.trim().toLowerCase()],
      name,
      displayName: this.readString(raw.displayName, raw.name),
      shortName: this.readString(
        raw.shortDisplayName,
        raw.abbreviation,
        raw.name,
      ),
      abbreviation: this.readString(raw.abbreviation, raw.abbr),
      slug: this.readString(raw.slug),
      logo,
      country: this.readString(
        country?.name,
        country?.abbreviation,
        raw.countryName,
      ),
      location: this.readString(raw.location, raw.city, raw.name),
      primaryColor: this.readString(raw.color, raw.primaryColor),
      alternateColor: this.readString(raw.alternateColor),
      rawPayload: this.cloneRaw(raw),
      source: this.source(
        endpoint ?? `/leagues/${leagueId}/teams/${espnId}`,
        espnId,
        collectedAt,
        raw,
      ),
      createdAt: collectedAt,
      updatedAt: collectedAt,
    };
  }

  normalizeFixture(
    value: unknown,
    context: FixtureNormalizationContext,
  ): SportsFixtureRecord {
    const event = this.asRecord(value);
    if (!event) throw new Error('ESPN scoreboard event is not an object.');
    const eventId = this.readEntityId(event);
    if (!eventId) throw new Error('ESPN scoreboard event has no event ID.');

    const competition =
      this.firstRecord(event.competitions) ??
      this.asRecord(event.competition) ??
      event;
    // Scoreboard events carry their own season object. This is especially
    // important for the unfiltered live scoreboard, which may return events
    // whose season differs from the fixture that scheduled the polling job.
    const season =
      this.asRecord(event.season) ?? this.asRecord(competition.season);
    const seasonYear = this.readNumber(
      season?.year,
      season?.seasonYear,
      context.seasonYear,
    );
    const seasonId = seasonYear
      ? this.seasonId(context.competitionId, seasonYear)
      : context.seasonId;
    const competitorValues = this.readArray(
      competition.competitors,
      event.competitors,
    );
    const competitors = competitorValues
      .map((item) => this.normalizeCompetitor(item))
      .filter((item): item is SportsFixtureCompetitor => Boolean(item));
    const home = competitors.find((item) => item.homeAway === 'HOME');
    const away = competitors.find((item) => item.homeAway === 'AWAY');
    if (!home || !away)
      throw new Error(
        `ESPN fixture ${eventId} does not contain both home and away competitors.`,
      );

    const kickoffAt = this.readDate(event.date, competition.date);
    if (!kickoffAt)
      throw new Error(
        `ESPN fixture ${eventId} does not contain a valid kickoff date.`,
      );
    const statusObject =
      this.asRecord(competition.status) ?? this.asRecord(event.status) ?? {};
    const status = this.normalizeStatus(statusObject);
    const venue =
      this.asRecord(competition.venue) ?? this.asRecord(event.venue);
    const venueId = venue ? this.readEntityId(venue) : undefined;
    const completedAt = status.isFinal
      ? this.readDate(
          competition.completedAt,
          event.completedAt,
          statusObject.completedAt,
          statusObject.type && this.asRecord(statusObject.type)?.completedAt,
        )
      : undefined;
    const collectedAt = context.collectedAt ?? new Date();

    return {
      id: this.fixtureId(eventId),
      espnEventId: eventId,
      espnCompetitionId: this.readEntityId(competition) ?? eventId,
      competitionId: context.competitionId,
      seasonId,
      seasonYear,
      name: this.readString(event.name, competition.name),
      shortName: this.readString(event.shortName, competition.shortName),
      kickoffAt,
      status,
      competitors: [home, away],
      periodScores: this.normalizePeriodScores(
        competitorValues,
        home.teamId,
        away.teamId,
      ),
      venueId: venueId ? `venue:${venueId}` : undefined,
      attendance: this.readNumber(competition.attendance, event.attendance),
      neutralSite: this.readBoolean(competition.neutralSite, event.neutralSite),
      completedAt,
      rawPayload: this.cloneRaw(event),
      source: this.source(
        `/leagues/${context.leagueId}/scoreboard`,
        eventId,
        collectedAt,
        event,
      ),
      createdAt: collectedAt,
      updatedAt: collectedAt,
    };
  }

  normalizeSummaryFixture(
    value: unknown,
    context: FixtureNormalizationContext,
  ): SportsFixtureRecord | null {
    const summary = this.asRecord(value);
    if (!summary) return null;
    const header = this.asRecord(summary.header) ?? {};
    const event =
      this.asRecord(summary.event) ?? this.asRecord(header.event) ?? {};
    const competition =
      this.firstRecord(header.competitions) ??
      this.firstRecord(event.competitions) ??
      this.asRecord(summary.competition);
    const eventId = this.readString(
      header.id,
      event.id,
      summary.id,
      context.competitionId,
    );
    if (!eventId || !competition) return null;

    const eventShape: ProviderJsonObject = {
      ...event,
      id: eventId,
      date: this.readString(
        event.date,
        competition.date,
        header.date,
        summary.date,
      ),
      name: this.readString(event.name, header.name, summary.name),
      shortName: this.readString(event.shortName, header.shortName),
      competitions: [competition],
      status: competition.status ?? event.status ?? header.status,
    };
    try {
      const fixture = this.normalizeFixture(eventShape, context);
      return {
        ...fixture,
        rawPayload: this.cloneRaw(summary),
        source: this.source(
          `/leagues/${context.leagueId}/summary?event=${eventId}`,
          eventId,
          context.collectedAt ?? new Date(),
          summary,
        ),
      };
    } catch {
      return null;
    }
  }

  normalizeMatchTimeline(
    value: unknown,
    context: {
      leagueId: string;
      eventId: string;
      competitionId: string;
      fixtureId: string;
      collectedAt?: Date;
    },
  ): SportsMatchTimelineEventRecord[] {
    const root = this.asRecord(value);
    if (!root) return [];
    const items = this.extractTimelineItems(root);
    const collectedAt = context.collectedAt ?? new Date();
    return items.map((value, index) => {
      const play = this.asRecord(value) ?? {};
      const playId = this.readEntityId(play);
      const period = this.asRecord(play.period);
      const clock = this.asRecord(play.clock);
      const teamId = this.referenceEntityId(play.team);
      const participants = this.readArray(
        play.athletesInvolved,
        play.participants,
        play.athletes,
      );
      const involvedAthletes = participants
        .map((participant) => {
          const item = this.asRecord(participant);
          if (!item) return undefined;
          const athlete =
            this.asRecord(item.athlete) ?? this.asRecord(item.player) ?? item;
          const espnAthleteId = this.readEntityId(athlete);
          const teamRef =
            this.asRecord(athlete.team) ?? this.asRecord(item.team);
          const teamEspnId = teamRef ? this.readEntityId(teamRef) : undefined;
          const positionRef =
            this.asRecord(item.position) ?? this.asRecord(athlete.position);
          const positionText = this.readString(
            athlete.positionName,
            item.positionName,
            item.position,
          );
          const positionId = positionRef
            ? this.readEntityId(positionRef)
            : undefined;
          const statisticsRef = this.readString(
            this.asRecord(item.statistics)?.$ref,
          );
          return {
            athleteId: espnAthleteId
              ? this.athleteId(espnAthleteId)
              : undefined,
            name: this.readString(
              athlete.fullName,
              athlete.displayName,
              athlete.name,
            ),
            shortName: this.readString(athlete.shortName),
            jersey: this.readString(item.jersey, athlete.jersey),
            teamId: teamEspnId ? this.teamId(teamEspnId) : undefined,
            position: positionText,
            positionId,
            statisticsRef,
            order: this.readNumber(item.order),
            role: this.readString(item.type, item.role),
          };
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item));
      const athleteIds = involvedAthletes
        .map((item) => item.athleteId)
        .filter((id): id is string => Boolean(id));
      const homeScore = this.readNumber(
        play.homeScore,
        play.home_score,
        play.scoreAfter && this.asRecord(play.scoreAfter)?.home,
      );
      const awayScore = this.readNumber(
        play.awayScore,
        play.away_score,
        play.scoreAfter && this.asRecord(play.scoreAfter)?.away,
      );
      const source = this.asRecord(play.source);
      const addedClock = this.asRecord(play.addedClock);
      const typeObject = this.asRecord(play.type);
      const type =
        this.readString(
          play.typeText,
          play.type_text,
          typeObject?.text,
          typeObject?.name,
          typeObject?.abbreviation,
          play.type,
        ) ?? 'UNKNOWN';
      return {
        id: playId
          ? `timeline:${context.fixtureId}:${playId}`
          : `timeline:${context.fixtureId}:${index + 1}`,
        espnPlayId: playId,
        fixtureId: context.fixtureId,
        sequence:
          this.readNumber(
            play.sequenceNumber,
            play.sequence_number,
            play.sequence,
            play.order,
          ) ?? index + 1,
        period: this.readNumber(
          play.periodNumber,
          play.period_number,
          period?.number,
          period?.id,
        ),
        clock: this.readString(
          play.clockDisplayValue,
          play.clock_display_value,
          clock?.displayValue,
          play.clock,
        ),
        clockSeconds: this.readNumber(clock?.value, play.clockSeconds),
        addedClock: this.readString(
          addedClock?.displayValue,
          addedClock?.value,
        ),
        type,
        typeId: this.readString(typeObject?.id),
        typeKey: this.readString(typeObject?.type),
        description: this.readString(
          play.text,
          play.description,
          play.commentary,
          play.alternativeText,
          play.alternative_text,
        ),
        teamId: teamId ? this.teamId(teamId) : undefined,
        athleteId: athleteIds[0] ?? undefined,
        relatedAthleteId: athleteIds[1] ?? undefined,
        involvedAthletes,
        homeScore,
        awayScore,
        scoreAfter:
          homeScore !== undefined && awayScore !== undefined
            ? { home: homeScore, away: awayScore }
            : undefined,
        scoreValue: this.readNumber(
          play.scoreValue,
          play.score_value,
          play.pointsAttempted,
          play.points_attempted,
        ),
        scoringPlay: this.readBoolean(play.scoringPlay, play.scoring_play),
        shootingPlay: this.readBoolean(play.shootingPlay, play.shooting_play),
        priority: this.readBoolean(play.priority),
        valid: this.readBoolean(play.valid),
        substitution: this.readBoolean(play.substitution),
        redCard: this.readBoolean(play.redCard),
        yellowCard: this.readBoolean(play.yellowCard),
        penaltyKick: this.readBoolean(play.penaltyKick),
        ownGoal: this.readBoolean(play.ownGoal),
        shootout: this.readBoolean(play.shootout),
        hasVideoTagging: this.readBoolean(play.hasVideoTagging),
        sourceId: this.readString(source?.id),
        sourceDescription: this.readString(source?.description),
        statYardage: this.readNumber(play.statYardage),
        coordinateX: this.readNumber(
          play.coordinateX,
          play.coordinate_x,
          play.fieldPositionX,
        ),
        coordinateY: this.readNumber(
          play.coordinateY,
          play.coordinate_y,
          play.fieldPositionY,
        ),
        fieldPositionX: this.readNumber(play.fieldPositionX),
        fieldPositionY: this.readNumber(play.fieldPositionY),
        fieldPosition2X: this.readNumber(play.fieldPosition2X),
        fieldPosition2Y: this.readNumber(play.fieldPosition2Y),
        periodDisplayValue: this.readString(
          play.periodDisplayValue,
          play.period_display_value,
        ),
        wallclock: this.readString(play.wallclock),
        shortText: this.readString(
          play.shortText,
          play.short_text,
          play.shortAlternativeText,
          play.short_alternative_text,
        ),
        modifiedAt: this.readDate(play.modified),
        modifiedDate: this.readDate(play.modifiedDate),
        probabilityRef: this.readString(
          this.asRecord(play.probability)?.$ref,
          play.probability,
        ),
        rawPayload: this.cloneRaw(play),
        source: this.source(
          `/leagues/${context.leagueId}/events/${context.eventId}/competitions/${context.competitionId}/plays`,
          playId,
          collectedAt,
          play,
        ),
        createdAt: collectedAt,
        updatedAt: collectedAt,
      };
    });
  }

  normalizeSummaryTimeline(
    value: unknown,
    context: {
      leagueId: string;
      eventId: string;
      competitionId: string;
      fixtureId: string;
      collectedAt?: Date;
    },
  ): SportsMatchTimelineEventRecord[] {
    const summary = this.asRecord(value);
    if (!summary) return [];
    // Summary keyEvents are the most complete event timeline. Only fall back to
    // commentary when keyEvents (and explicit plays/scoringPlays) are absent.
    const preferred =
      [summary.plays, summary.keyEvents, summary.scoringPlays, summary.timeline]
        .map((candidate) =>
          this.extractTimelineItems(
            this.asRecord(candidate) ?? {
              items: Array.isArray(candidate) ? candidate : [],
            },
          ),
        )
        .find((items) => items.length) ?? [];
    const commentary = this.readArray(summary.commentary)
      .map((item) => this.asRecord(item)?.play ?? item)
      .filter((item) => Boolean(this.asRecord(item)));
    const flattened = preferred.length ? preferred : commentary;
    if (!flattened.length) return [];
    return this.normalizeMatchTimeline({ items: flattened }, context).map(
      (item) => ({
        ...item,
        source: {
          ...item.source,
          endpoint: `/leagues/${context.leagueId}/summary?event=${context.eventId}#plays`,
        },
      }),
    );
  }

  normalizeEspnOdds(
    value: unknown,
    context: OddsNormalizationContext,
    endpoint: string,
  ): SportsMatchOddsSnapshotRecord | null {
    const root = this.asRecord(value);
    if (!root) return null;
    const items = this.readFirstNonEmptyArray(root.items, root.odds, root.providers);
    const sourceItems = items.length
      ? items
      : this.looksLikeOddsRow(root)
        ? [root]
        : [];
    const bookmakers = sourceItems
      .map((item) => this.normalizeBookmaker(item, context))
      .filter((item): item is SportsOddsBookmaker => Boolean(item));
    if (!bookmakers.length) return null;
    return this.createOddsSnapshot(
      context,
      'ESPN',
      false,
      bookmakers,
      endpoint,
      root,
    );
  }

  normalizeEspnSummaryOdds(
    value: unknown,
    context: OddsNormalizationContext,
    endpoint: string,
  ): SportsMatchOddsSnapshotRecord | null {
    const summary = this.asRecord(value);
    if (!summary) return null;
    const oddsObject = this.asRecord(summary.odds);
    const pickcenter = this.readFirstNonEmptyArray(
      summary.pickcenter,
      summary.odds,
      oddsObject?.value,
      oddsObject?.items,
      oddsObject?.providers,
    );
    const bookmakers = pickcenter
      .map((item) => this.normalizeBookmaker(item, context))
      .filter((item): item is SportsOddsBookmaker => Boolean(item));
    if (!bookmakers.length) return null;
    return this.createOddsSnapshot(
      context,
      'ESPN_SUMMARY',
      true,
      bookmakers,
      endpoint,
      summary,
    );
  }

  /** Normalize The Odds API event payload using its bookmaker/market/outcome structure. */
  normalizeOddsApiEvent(
    value: unknown,
    context: OddsNormalizationContext,
  ): SportsMatchOddsSnapshotRecord | null {
    const event = this.asRecord(value);
    if (!event) return null;

    const homeName = this.readString(event.home_team);
    const awayName = this.readString(event.away_team);
    const kickoff = this.readDate(event.commence_time);
    if (
      !homeName ||
      !awayName ||
      this.normalizeTeamName(homeName) !==
        this.normalizeTeamName(context.homeTeam) ||
      this.normalizeTeamName(awayName) !==
        this.normalizeTeamName(context.awayTeam) ||
      !kickoff ||
      Math.abs(kickoff.getTime() - context.kickoffAt.getTime()) >
        6 * 60 * 60_000
    )
      return null;

    const bookmakers = this.readArray(event.bookmakers)
      .map((bookmakerValue) => {
        const bookmaker = this.asRecord(bookmakerValue);
        if (!bookmaker) return null;
        const name = this.readString(bookmaker.title, bookmaker.key);
        if (!name) return null;
        const markets = this.readArray(bookmaker.markets)
          .map((marketValue) => {
            const market = this.asRecord(marketValue);
            if (!market) return null;
            const key = this.readString(market.key);
            if (!key) return null;
            const outcomes = this.readArray(market.outcomes)
              .map((outcomeValue) => {
                const outcome = this.asRecord(outcomeValue);
                if (!outcome) return null;
                const selection = this.readString(outcome.name);
                const price = this.readNumber(outcome.price);
                if (!selection || price === undefined || price <= 1)
                  return null;
                const point = this.readNumber(outcome.point);
                return {
                  selection,
                  price,
                  point: point ?? null,
                  isSuspended: false,
                };
              })
              .filter((outcome): outcome is NonNullable<typeof outcome> =>
                Boolean(outcome),
              );
            if (!outcomes.length) return null;
            return {
              marketKey: key,
              marketName: this.readString(market.title, key) ?? key,
              outcomes,
              providerUpdatedAt: this.readDate(market.last_update),
            };
          })
          .filter((market): market is NonNullable<typeof market> =>
            Boolean(market),
          );
        if (!markets.length) return null;
        return {
          bookmakerId: this.readString(bookmaker.key),
          bookmakerName: name,
          markets: markets.map((market) => ({
            marketKey: market.marketKey,
            marketName: market.marketName,
            outcomes: market.outcomes,
            providerUpdatedAt: market.providerUpdatedAt,
          })),
        };
      })
      .filter((bookmaker): bookmaker is NonNullable<typeof bookmaker> =>
        Boolean(bookmaker),
      );

    if (!bookmakers.length) return null;
    const collectedAt = context.collectedAt ?? new Date();
    return {
      id: `odds:${context.fixtureId}:ODDS_API:${collectedAt.getTime()}`,
      fixtureId: context.fixtureId,
      provider: 'ODDS_API',
      isFallback: true,
      collectedAt,
      bookmakers,
      rawPayload: this.cloneRaw(event),
      source: this.source(
        `/sports/${this.readString(event.sport_key) ?? 'unknown'}/events/${this.readString(event.id) ?? 'unknown'}/odds`,
        this.readString(event.id),
        collectedAt,
        event,
        'ODDS_API',
      ),
      createdAt: collectedAt,
    };
  }

  private normalizeTeamName(value: string): string {
    return value
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\\u0300-\\u036f]/g, '')
      .replace(/[^a-z0-9]/g, '');
  }

  private normalizeBookmaker(
    value: unknown,
    context: OddsNormalizationContext,
  ): SportsOddsBookmaker | null {
    const row = this.asRecord(value);
    if (!row) return null;
    const provider = this.asRecord(row.provider);
    const providerName =
      this.readString(
        provider?.displayName,
        provider?.name,
        provider?.title,
        row.providerName,
        row.provider_name,
        row.bookmakerName,
        row.name,
      ) ??
      (provider?.$ref
        ? `ESPN provider ${this.readEntityId(provider) ?? ''}`.trim()
        : undefined);
    if (!providerName) return null;
    const providerId = this.readString(
      provider?.id,
      row.providerId,
      row.provider_id,
      provider?.$ref && this.readEntityId(provider),
    );

    const markets = this.readFirstNonEmptyArray(row.markets, row.market, row.lines)
      .map((market) => this.normalizeMarket(market))
      .filter((market): market is ParsedMarket => Boolean(market));
    const allMarkets = markets.length
      ? markets
      : this.directOddsMarkets(row, context);
    if (!allMarkets.length) return null;

    return {
      bookmakerId: providerId,
      bookmakerName: providerName,
      priority: this.readNumber(provider?.priority, row.priority),
      markets: allMarkets.map((market) => ({
        marketId: market.marketId,
        marketKey: market.marketKey,
        marketName: market.marketName,
        outcomes: market.outcomes,
        providerUpdatedAt: market.providerUpdatedAt,
      })),
    };
  }

  private normalizeMarket(value: unknown): ParsedMarket | null {
    const raw = this.asRecord(value);
    if (!raw) return null;
    const key = this.readString(
      raw.key,
      raw.marketKey,
      raw.marketKey,
      raw.name,
      raw.type,
      raw.id,
    );
    const name = this.readString(raw.name, raw.title, raw.displayName, key);
    if (!key || !name) return null;
    const outcomes = this.readFirstNonEmptyArray(raw.outcomes, raw.selections, raw.lines)
      .map((value) => {
        const outcome = this.asRecord(value);
        if (!outcome) return null;
        const selection = this.readString(
          outcome.name,
          outcome.label,
          outcome.description,
          outcome.selection,
          outcome.participant,
        );
        const price = this.readOddsPrice(outcome);
        if (!selection || price === undefined || price <= 1) return null;
        return {
          selection,
          price,
          point:
            this.readNumber(outcome.point, outcome.handicap, outcome.total) ??
            null,
          isSuspended:
            this.readBoolean(
              outcome.suspended,
              outcome.isSuspended,
              outcome.is_suspended,
            ) ?? false,
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    if (!outcomes.length) return null;
    return {
      marketKey: key,
      marketName: name,
      marketId: this.readString(raw.id, raw.marketId),
      outcomes,
      providerUpdatedAt: this.readDate(
        raw.lastUpdate,
        raw.last_update,
        raw.updatedAt,
      ),
    };
  }

  /** Supports the exact ESPN Core Odds and Site Summary pickcenter structures. */
  private directOddsMarkets(
    row: ProviderJsonObject,
    context: OddsNormalizationContext,
  ): ParsedMarket[] {
    const home =
      this.asRecord(row.homeTeamOdds) ??
      this.asRecord(row.home_team_odds) ??
      {};
    const away =
      this.asRecord(row.awayTeamOdds) ??
      this.asRecord(row.away_team_odds) ??
      {};
    const draw =
      this.asRecord(row.drawOdds) ?? this.asRecord(row.draw_odds) ?? {};
    const homeCurrent =
      this.asRecord(home.current) ?? this.asRecord(home.currentLine) ?? {};
    const awayCurrent =
      this.asRecord(away.current) ?? this.asRecord(away.currentLine) ?? {};
    const homeOpen =
      this.asRecord(home.open) ?? this.asRecord(home.openLine) ?? {};
    const awayOpen =
      this.asRecord(away.open) ?? this.asRecord(away.openLine) ?? {};
    const homeNestedOdds = this.asRecord(home.odds);
    const awayNestedOdds = this.asRecord(away.odds);
    const providerUpdatedAt = this.readDate(
      row.lastUpdate,
      row.last_update,
      row.updatedAt,
      row.modified,
    );
    const markets: ParsedMarket[] = [];

    // In Core Odds, top-level moneyLine/spreadOdds values are American prices.
    // The nested current/open/close objects expose `value`/`decimal` as decimal odds.
    const homeMoneyline =
      this.readAmericanOrPriceObject(home.moneyLine ?? home.moneyline) ??
      this.readAmericanOrPriceObject(
        homeCurrent.moneyLine ?? homeCurrent.moneyline,
      ) ??
      this.readDecimalOrAmericanFields(
        row.homeTeamOddsCurrentMoneyLineDecimal,
        row.homeTeamOddsCurrentMoneyLineValue,
        row.homeTeamOddsCurrentMoneyLineAmerican,
        row.home_team_odds_current_money_line_decimal,
        row.home_team_odds_current_money_line_value,
      ) ??
      (homeNestedOdds ? this.readOddsPrice(homeNestedOdds) : undefined);
    const awayMoneyline =
      this.readAmericanOrPriceObject(away.moneyLine ?? away.moneyline) ??
      this.readAmericanOrPriceObject(
        awayCurrent.moneyLine ?? awayCurrent.moneyline,
      ) ??
      this.readDecimalOrAmericanFields(
        row.awayTeamOddsCurrentMoneyLineDecimal,
        row.awayTeamOddsCurrentMoneyLineValue,
        row.awayTeamOddsCurrentMoneyLineAmerican,
        row.away_team_odds_current_money_line_decimal,
        row.away_team_odds_current_money_line_value,
      ) ??
      (awayNestedOdds ? this.readOddsPrice(awayNestedOdds) : undefined);
    const drawMoneyline =
      this.readAmericanOrPriceObject(draw.moneyLine ?? draw.moneyline) ??
      this.readAmericanOrPriceObject(draw.current) ??
      (Object.keys(draw).length ? this.readOddsPrice(draw) : undefined) ??
      this.readAmericanOrPriceObject(row.drawMoneyLine ?? row.draw_money_line);
    const h2h = [
      this.outcome(context.homeTeam, homeMoneyline),
      this.outcome(context.awayTeam, awayMoneyline),
      this.outcome('Draw', drawMoneyline),
    ].filter((item): item is NonNullable<typeof item> => Boolean(item));
    if (h2h.length >= 2)
      markets.push({
        marketKey: 'h2h',
        marketName: 'Match Winner',
        outcomes: h2h,
        providerUpdatedAt,
      });

    const homeCurrentPoint = this.asRecord(homeCurrent.pointSpread);
    const awayCurrentPoint = this.asRecord(awayCurrent.pointSpread);
    const spreadPoint = this.readNumber(
      row.spread,
      homeCurrentPoint?.value,
      homeCurrentPoint?.american,
      homeCurrentPoint?.alternateDisplayValue,
      (() => {
        const awayPoint = this.readNumber(
          awayCurrentPoint?.value,
          awayCurrentPoint?.american,
          awayCurrentPoint?.alternateDisplayValue,
        );
        return awayPoint === undefined ? undefined : -awayPoint;
      })(),
      homeOpen.pointSpread && this.asRecord(homeOpen.pointSpread)?.american,
    );
    const homeSpread =
      this.readAmericanOrPriceObject(home.spreadOdds ?? home.spread_odds) ??
      this.readAmericanOrPriceObject(
        homeCurrent.spread ?? homeCurrent.spreadOdds,
      ) ??
      this.readAmericanOrPriceObject(homeOpen.spread) ??
      this.readDecimalOrAmericanFields(
        row.homeTeamOddsCurrentSpreadDecimal,
        row.homeTeamOddsCurrentSpreadValue,
        row.homeTeamOddsCurrentSpreadAmerican,
      );
    const awaySpread =
      this.readAmericanOrPriceObject(away.spreadOdds ?? away.spread_odds) ??
      this.readAmericanOrPriceObject(
        awayCurrent.spread ?? awayCurrent.spreadOdds,
      ) ??
      this.readAmericanOrPriceObject(awayOpen.spread) ??
      this.readDecimalOrAmericanFields(
        row.awayTeamOddsCurrentSpreadDecimal,
        row.awayTeamOddsCurrentSpreadValue,
        row.awayTeamOddsCurrentSpreadAmerican,
      );
    const spreads = [
      this.outcome(context.homeTeam, homeSpread, spreadPoint),
      this.outcome(
        context.awayTeam,
        awaySpread,
        spreadPoint === undefined ? undefined : -spreadPoint,
      ),
    ].filter((item): item is NonNullable<typeof item> => Boolean(item));
    if (spreads.length === 2)
      markets.push({
        marketKey: 'spreads',
        marketName: 'Asian Handicap / Spread',
        outcomes: spreads,
        providerUpdatedAt,
      });

    const totalObject = this.asRecord(row.total);
    const total = this.readNumber(
      row.overUnder,
      row.over_under,
      totalObject?.value,
      totalObject?.displayValue,
      row.total,
    );
    const overPrice =
      this.readAmericanOrPriceObject(row.overOdds ?? row.over_odds) ??
      this.readAmericanOrPriceObject(row.currentOver ?? row.over) ??
      this.readAmericanOrPriceObject(row.openOver ?? row.open_over);
    const underPrice =
      this.readAmericanOrPriceObject(row.underOdds ?? row.under_odds) ??
      this.readAmericanOrPriceObject(row.currentUnder ?? row.under) ??
      this.readAmericanOrPriceObject(row.openUnder ?? row.open_under);
    const totals = [
      this.outcome('Over', overPrice, total),
      this.outcome('Under', underPrice, total),
    ].filter((item): item is NonNullable<typeof item> => Boolean(item));
    if (totals.length === 2)
      markets.push({
        marketKey: 'totals',
        marketName: 'Over / Under',
        outcomes: totals,
        providerUpdatedAt,
      });

    // Bet365-style ESPN rows expose additional markets through
    // bettingOdds.teamOdds, keyed by names such as
    // preMatchFullTimeResultDraw and liveDoubleChanceHomeOrDraw.
    // Preserve usable price entries as normalized markets as well as in rawPayload.
    const bettingOdds =
      this.asRecord(row.bettingOdds) ?? this.asRecord(row.betting_odds);
    const teamOdds =
      this.asRecord(bettingOdds?.teamOdds) ??
      this.asRecord(bettingOdds?.team_odds);
    if (teamOdds) {
      const grouped = new Map<string, ParsedMarket>();
      for (const [sourceKey, sourceValue] of Object.entries(teamOdds)) {
        const key = sourceKey.trim();
        if (!key || /handicap/i.test(key)) continue; // These entries describe line points, not prices.
        const sourceRow = this.asRecord(sourceValue);
        if (!sourceRow) continue;
        const price = this.readOddsPrice(sourceRow);
        if (price === undefined || price <= 1) continue;

        const suffixMatch = key.match(
          /(HomeOrDraw|AwayOrDraw|HomeOrAway|Home|Away|Draw|Over|Under)$/i,
        );
        const suffix = suffixMatch?.[1];
        const baseKey = suffix ? key.slice(0, -suffix.length) : key;
        const scopePrefix = /^live/i.test(baseKey) ? 'Live' : 'Pre-match';
        const baseName = baseKey
          .replace(/^(live|preMatch)/i, '')
          .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
          .trim();
        const marketKey = `betting:${baseKey.toLowerCase()}`;
        const marketName = `${scopePrefix} ${baseName || 'Additional Market'}`;
        const selection = suffix
          ? suffix.replace(/([a-z])([A-Z])/g, '$1 $2')
          : key.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
        const existing = grouped.get(marketKey) ?? {
          marketKey,
          marketName,
          outcomes: [],
          providerUpdatedAt,
        };
        existing.outcomes.push({
          selection,
          price,
          point: this.readNumber(sourceRow.point, sourceRow.handicap) ?? null,
          isSuspended:
            this.readBoolean(sourceRow.suspended, sourceRow.isSuspended) ??
            false,
        });
        grouped.set(marketKey, existing);
      }
      markets.push(...grouped.values());
    }

    const details = this.readString(row.details, row.displayName);
    if (!markets.length && details) {
      const price = this.readOddsPrice(row);
      if (price !== undefined)
        markets.push({
          marketKey:
            this.readString(row.marketKey, row.market_key, row.type) ??
            'espn-market',
          marketName: details,
          outcomes: [
            { selection: details, price, point: null, isSuspended: false },
          ],
          providerUpdatedAt,
        });
    }
    return markets;
  }

  private readAmericanOrPriceObject(value: unknown): number | undefined {
    if (value === undefined || value === null) return undefined;
    const row = this.asRecord(value);
    if (row) return this.readOddsPrice(row);
    return this.fractionalToDecimal(value) ?? this.americanToDecimal(value);
  }

  private readDecimalOrAmericanFields(
    decimal: unknown,
    value: unknown,
    american: unknown,
    fallbackDecimal?: unknown,
    fallbackValue?: unknown,
  ): number | undefined {
    const decimalValue = this.readNumber(decimal, fallbackDecimal);
    if (decimalValue !== undefined && decimalValue > 1 && decimalValue < 1_000)
      return decimalValue;
    return this.americanToDecimal(american ?? value ?? fallbackValue);
  }

  private readOddsPrice(value: ProviderJsonObject): number | undefined {
    const nested =
      this.asRecord(value.odds) ?? this.asRecord(value.price) ?? value;
    return this.normalizePrice(
      nested.decimalOdds ??
        nested.decimal ??
        nested.decimalValue ??
        nested.value,
      nested.americanOdds ?? nested.american ?? nested.americanValue,
    );
  }

  private americanToDecimal(value: unknown): number | undefined {
    const american = this.readNumber(value);
    if (american === undefined || american === 0) return undefined;
    if (american > 0) return 1 + american / 100;
    if (american < 0) return 1 + 100 / Math.abs(american);
    return undefined;
  }

  private outcome(
    selection: string,
    price?: number,
    point?: number,
  ): SportsOddsMarket['outcomes'][number] | null {
    return price !== undefined && price > 1
      ? { selection, price, point: point ?? null, isSuspended: false }
      : null;
  }

  private normalizePrice(
    decimal: unknown,
    american: unknown,
  ): number | undefined {
    const decimalValue = this.readNumber(decimal);
    if (decimalValue !== undefined && decimalValue > 1 && decimalValue < 1_000)
      return decimalValue;
    return (
      this.fractionalToDecimal(decimal) ??
      this.fractionalToDecimal(american) ??
      this.americanToDecimal(american ?? decimal)
    );
  }

  /** ESPN pickcenter can provide fractional prices such as 12/5 or 1/12. */
  private fractionalToDecimal(value: unknown): number | undefined {
    if (typeof value !== 'string') return undefined;
    const match = value
      .trim()
      .match(/^(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
    if (!match) return undefined;
    const numerator = Number(match[1]);
    const denominator = Number(match[2]);
    if (
      !Number.isFinite(numerator) ||
      !Number.isFinite(denominator) ||
      denominator <= 0
    )
      return undefined;
    const decimal = 1 + numerator / denominator;
    return decimal > 1 && decimal < 1_000 ? decimal : undefined;
  }

  private createOddsSnapshot(
    context: OddsNormalizationContext,
    provider: 'ESPN' | 'ESPN_SUMMARY' | 'ODDS_API',
    isFallback: boolean,
    bookmakers: SportsOddsBookmaker[],
    endpoint: string,
    raw: ProviderJsonObject,
  ): SportsMatchOddsSnapshotRecord {
    const collectedAt = context.collectedAt ?? new Date();
    return {
      id: `odds:${context.fixtureId}:${provider}:${collectedAt.getTime()}`,
      fixtureId: context.fixtureId,
      provider,
      isFallback,
      collectedAt,
      bookmakers,
      rawPayload: this.cloneRaw(raw),
      source: this.source(
        endpoint,
        context.eventId,
        collectedAt,
        raw,
        provider === 'ODDS_API' ? 'ODDS_API' : 'ESPN',
      ),
      createdAt: collectedAt,
    };
  }

  private normalizeCompetitor(value: unknown): SportsFixtureCompetitor | null {
    const row = this.asRecord(value);
    if (!row) return null;
    const team = this.asRecord(row.team) ?? row;
    const espnTeamId = this.readEntityId(team) ?? this.readEntityId(row);
    const homeAwayRaw = this.readString(
      row.homeAway,
      row.home_away,
    )?.toUpperCase();
    const homeAway =
      homeAwayRaw === 'HOME' || homeAwayRaw === 'AWAY'
        ? homeAwayRaw
        : undefined;
    if (!espnTeamId || !homeAway) return null;
    return {
      teamId: this.teamId(espnTeamId),
      espnCompetitorId: this.readString(row.id),
      homeAway,
      score:
        this.readNumber(row.score, row.scoreValue, row.score_value) ?? null,
      winner: this.readBoolean(row.winner),
      form: this.readString(row.form),
      records: this.readArray(row.records).filter((item) =>
        Boolean(this.asRecord(item)),
      ) as Array<Record<string, unknown>>,
      statistics: this.readArray(row.statistics).filter((item) =>
        Boolean(this.asRecord(item)),
      ) as Array<Record<string, unknown>>,
      leaders: this.readArray(row.leaders).filter((item) =>
        Boolean(this.asRecord(item)),
      ) as Array<Record<string, unknown>>,
      rawPayload: this.cloneRaw(row),
    };
  }

  private normalizeStatus(
    raw: ProviderJsonObject,
  ): SportsFixtureRecord['status'] {
    const type = this.asRecord(raw.type) ?? {};
    const providerState =
      this.readString(type.state, type.name, raw.state, raw.name) ?? 'UNKNOWN';
    const normalized = providerState.toLowerCase();
    const statusText =
      `${providerState} ${this.readString(type.description, raw.description, raw.shortDetail, raw.detail) ?? ''}`.toLowerCase();
    let state: SportsFixtureState = 'UNKNOWN';
    if (/postponed|ppd/.test(statusText)) state = 'POSTPONED';
    else if (/cancelled|canceled/.test(statusText)) state = 'CANCELLED';
    else if (/abandoned/.test(statusText)) state = 'ABANDONED';
    else if (
      this.readBoolean(type.completed, raw.completed) === true ||
      /final|complete|finished|ft\b/.test(statusText) ||
      normalized === 'post'
    )
      state = 'COMPLETED';
    else if (/penalt/.test(statusText)) state = 'PENALTIES';
    else if (/extra time|aet|extra_time/.test(statusText)) state = 'EXTRA_TIME';
    else if (/half.?time|halftime|ht\b/.test(statusText)) state = 'HALFTIME';
    else if (
      normalized === 'in' ||
      /live|in progress|playing|1st half|2nd half/.test(statusText)
    )
      state = 'LIVE';
    else if (
      normalized === 'pre' ||
      /scheduled|upcoming|not started|kickoff/.test(statusText)
    )
      state = 'SCHEDULED';

    const clock = this.asRecord(raw.clock);
    return {
      state,
      providerState,
      name: this.readString(type.name, raw.name),
      description: this.readString(
        type.description,
        raw.description,
        raw.detail,
      ),
      shortDescription: this.readString(
        type.shortDetail,
        raw.shortDetail,
        raw.shortDescription,
      ),
      period: this.readNumber(raw.period, raw.periodNumber, type.period),
      clock: this.readString(clock?.value, raw.clock),
      displayClock: this.readString(
        raw.displayClock,
        raw.display_clock,
        clock?.displayValue,
      ),
      isFinal: state === 'COMPLETED',
    };
  }

  private normalizePeriodScores(
    rawCompetitors: unknown[],
    homeId: string,
    awayId: string,
  ): SportsFixturePeriodScore[] {
    const output: SportsFixturePeriodScore[] = [];
    for (const value of rawCompetitors) {
      const row = this.asRecord(value);
      if (!row) continue;
      const team = this.asRecord(row.team) ?? row;
      const espnId = this.readEntityId(team) ?? this.readEntityId(row);
      if (!espnId) continue;
      const teamId = this.teamId(espnId);
      for (const [index, value] of this.readArray(
        row.linescores,
        row.lineScores,
        row.periodScores,
        row.lines,
      ).entries()) {
        const line = this.asRecord(value);
        const score = this.readNumber(
          line?.value,
          line?.score,
          line?.displayValue,
          value,
        );
        if (score === undefined || score < 0) continue;
        const period =
          this.readNumber(
            line?.periodNumber,
            this.asRecord(line?.period)?.number,
            line?.period,
            index + 1,
          ) ?? index + 1;
        output.push({ teamId, period, score });
      }
    }
    return output.filter(
      (item) => item.teamId === homeId || item.teamId === awayId,
    );
  }

  private extractTimelineItems(root: ProviderJsonObject): unknown[] {
    const preferredKeys = [
      'items',
      'plays',
      'events',
      'keyEvents',
      'scoringPlays',
      'timeline',
      'commentary',
      'data',
    ] as const;
    const nestedKeys = [
      'items',
      'plays',
      'events',
      'entries',
      'keyEvents',
      'scoringPlays',
      'timeline',
    ] as const;

    // Some ESPN envelopes contain `items: []` alongside a populated fallback
    // collection. Select the first NON-EMPTY array rather than accepting the
    // first array encountered, matching the odds normalizer's safe behaviour.
    for (const key of preferredKeys) {
      const candidate = root[key];
      if (Array.isArray(candidate) && candidate.length > 0) return candidate;
      const nested = this.asRecord(candidate);
      if (!nested) continue;
      for (const nestedKey of nestedKeys) {
        const nestedValue = nested[nestedKey];
        if (Array.isArray(nestedValue) && nestedValue.length > 0)
          return nestedValue;
      }
    }

    // Preserve an actual empty collection only as the final result; never let
    // it mask a non-empty array in a later supported field.
    for (const key of preferredKeys) {
      if (Array.isArray(root[key])) return root[key] as unknown[];
      const nested = this.asRecord(root[key]);
      if (nested) {
        for (const nestedKey of nestedKeys) {
          if (Array.isArray(nested[nestedKey]))
            return nested[nestedKey] as unknown[];
        }
      }
    }
    return [];
  }

  private looksLikeOddsRow(value: ProviderJsonObject): boolean {
    return Boolean(
      value.providerName ||
      value.provider_name ||
      value.provider ||
      value.markets ||
      value.homeTeamOdds ||
      value.home_team_odds ||
      value.overUnder ||
      value.over_under ||
      value.details,
    );
  }

  private source(
    endpoint: string,
    providerId: string | undefined,
    collectedAt: Date,
    raw?: ProviderJsonObject,
    provider: 'ESPN' | 'ODDS_API' = 'ESPN',
  ): SportsSourceMetadata {
    return {
      provider,
      providerId,
      endpoint,
      collectedAt,
      providerUpdatedAt: this.readDate(
        raw?.lastModified,
        raw?.last_modified,
        raw?.updatedAt,
        raw?.dateModified,
        raw?.modified,
      ),
    };
  }

  private competitionType(
    raw: ProviderJsonObject,
    isTournament: boolean,
  ): SportsCompetitionType {
    const type = this.asRecord(raw.type);
    const text =
      `${this.readString(type?.name, type?.text, raw.type, raw.competitionType, raw.name) ?? ''}`.toUpperCase();
    if (
      isTournament ||
      /CUP|TOURNAMENT|CHAMPIONSHIP|WORLD|EURO|NATIONS/.test(text)
    )
      return 'CLUB_COMPETITION';
    if (/NATIONAL|INTERNATIONAL|WORLD CUP|EURO|AFCON/.test(text))
      return 'INTERNATIONAL';
    return 'LEAGUE';
  }

  private competitionRegion(
    country?: unknown,
    abbreviation?: unknown,
    slug?: unknown,
  ): SportsCompetitionRegion {
    const value = [country, abbreviation, slug]
      .map((item) => this.readString(item) ?? '')
      .join(' ')
      .toLowerCase();
    if (/nigeria|npfl|nga\./.test(value)) return 'NIGERIA';
    if (
      /africa|ghana|south africa|kenya|uganda|egypt|morocco|tunisia|caf\./.test(
        value,
      )
    )
      return 'AFRICA';
    if (
      /europe|england|spain|italy|germany|france|uefa|netherlands|portugal|scotland|belgium|eng\.|esp\.|ita\.|ger\.|fra\./.test(
        value,
      )
    )
      return 'EUROPE';
    if (
      /brazil|argentina|conmebol|uruguay|chile|colombia|peru|bra\.|arg\./.test(
        value,
      )
    )
      return 'SOUTH_AMERICA';
    if (/usa|united states|mexico|canada|concacaf|usa\.|mex\./.test(value))
      return 'NORTH_AMERICA';
    if (/asia|saudi|japan|korea|afc|india|australia|ksa\./.test(value))
      return 'ASIA';
    return 'WORLD';
  }

  competitionId(leagueId: string): string {
    return `competition:${leagueId.trim().toLowerCase()}`;
  }
  seasonId(competitionId: string, year: number): string {
    return `season:${competitionId}:${year}`;
  }
  teamId(espnTeamId: string): string {
    return `team:${espnTeamId}`;
  }
  fixtureId(eventId: string): string {
    return `fixture:${eventId}`;
  }
  athleteId(espnAthleteId: string): string {
    return `athlete:${espnAthleteId}`;
  }

  readLeagueId(value: unknown): string | undefined {
    const row = this.asRecord(value);
    const direct = this.readString(row?.slug, row?.leagueId, row?.abbreviation);
    if (direct?.includes('.')) return direct.toLowerCase();
    const reference = this.readString(row?.$ref);
    const match = reference?.match(/\/leagues\/([^/?#]+)/i);
    return match?.[1]
      ? decodeURIComponent(match[1]).toLowerCase()
      : direct?.toLowerCase();
  }

  readTeamId(value: unknown): string | undefined {
    const row = this.asRecord(value);
    const direct = this.readString(row?.id, row?.espnId);
    if (direct) return direct;
    return this.idFromReference(
      this.readString(row?.$ref),
      /\/teams\/([^/?#]+)/i,
    );
  }

  readSeasonYear(value: unknown): number | undefined {
    const row = this.asRecord(value);
    return (
      this.readNumber(row?.year, row?.seasonYear, row?.id) ??
      this.yearFromRef(row?.$ref)
    );
  }

  private readEntityId(raw: ProviderJsonObject): string | undefined {
    const direct = this.readString(raw.id, raw.espnId);
    if (direct) return direct;
    return this.idFromReference(
      this.readString(raw.$ref),
      /\/([^/?#]+)(?:[?#].*)?$/,
    );
  }

  private referenceEntityId(value: unknown): string | undefined {
    const row = this.asRecord(value);
    if (!row) return undefined;
    return this.readEntityId(row);
  }

  private idFromReference(
    reference: string | undefined,
    pattern: RegExp,
  ): string | undefined {
    if (!reference) return undefined;
    const match = reference.match(pattern);
    if (!match?.[1]) return undefined;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }

  private yearFromRef(value: unknown): number | undefined {
    const match = this.readString(value)?.match(/\/seasons\/(\d+)(?:\/|\?|$)/i);
    const year = match ? Number(match[1]) : undefined;
    return year && year >= 1800 && year <= 3000 ? year : undefined;
  }

  private readImage(...values: unknown[]): string | undefined {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (Array.isArray(value)) {
        for (const item of value) {
          const row = this.asRecord(item);
          const href = this.readString(row?.href, row?.url, row?.src);
          if (href) return href;
        }
      }
      const row = this.asRecord(value);
      const href = this.readString(row?.href, row?.url, row?.src);
      if (href) return href;
    }
    return undefined;
  }

  private cloneRaw(value: ProviderJsonObject): ProviderJsonObject {
    return JSON.parse(JSON.stringify(value)) as ProviderJsonObject;
  }

  private firstRecord(value: unknown): ProviderJsonObject | undefined {
    return this.readArray(value)
      .map((item) => this.asRecord(item))
      .find(Boolean);
  }

  private readFirstNonEmptyArray(...values: unknown[]): unknown[] {
    // Odds payloads can contain an empty preferred array alongside a populated
    // alternate location (for example pickcenter: [] with odds.value populated).
    for (const value of values) {
      if (Array.isArray(value) && value.length > 0) return value;
    }
    return this.readArray(...values);
  }

  private readArray(...values: unknown[]): unknown[] {
    for (const value of values) {
      if (Array.isArray(value)) return value;
    }
    return [];
  }

  private asRecord(value: unknown): ProviderJsonObject | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as ProviderJsonObject)
      : undefined;
  }

  private readString(...values: unknown[]): string | undefined {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (typeof value === 'number' && Number.isFinite(value))
        return String(value);
    }
    return undefined;
  }

  private readNumber(...values: unknown[]): number | undefined {
    for (const value of values) {
      if (value === null || value === undefined || value === '') continue;
      const number = typeof value === 'number' ? value : Number(value);
      if (Number.isFinite(number)) return number;
    }
    return undefined;
  }

  private readBoolean(...values: unknown[]): boolean | undefined {
    for (const value of values) {
      if (typeof value === 'boolean') return value;
      if (value === 1 || value === '1' || value === 'true') return true;
      if (value === 0 || value === '0' || value === 'false') return false;
    }
    return undefined;
  }

  private readDate(...values: unknown[]): Date | undefined {
    for (const value of values) {
      if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
      if (typeof value === 'string' || typeof value === 'number') {
        const parsed = new Date(value);
        if (!Number.isNaN(parsed.getTime())) return parsed;
      }
    }
    return undefined;
  }
}

