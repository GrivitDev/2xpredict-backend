import { Injectable } from '@nestjs/common';
import { SettlementEventFacts } from '../interfaces/settlement-context.interface';
import { createSettlementSourceFingerprint } from '../utils/summary-fingerprint.util';

type R = Record<string, unknown>;
const record = (value: unknown): R | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as R)
    : undefined;
const array = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
const str = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    typeof value === 'symbol'
  )
    return String(value).trim();
  return '';
};
const num = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const match = value.trim().match(/^-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const footballScore = (value: unknown): number | undefined => {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim()))
    return undefined;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
};
const normalize = (value: unknown): string =>
  str(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
const first = (...values: unknown[]): unknown =>
  values.find((value) => value !== undefined && value !== null && value !== '');

@Injectable()
export class FootballMatchFactsService {
  extract(fixtureValue: unknown): SettlementEventFacts {
    const fixture = record(fixtureValue) ?? {};
    const payload = record(fixture.payload) ?? {};
    const summary = record(payload.summary) ?? {};
    const fixtureCompetitions = array(payload.competitions)
      .map(record)
      .filter(Boolean) as R[];
    const summaryHeader = record(summary.header) ?? {};
    const headerCompetitions = array(summaryHeader.competitions)
      .map(record)
      .filter(Boolean) as R[];

    const eventId = str(fixture.eventId ?? payload.id);
    const leagueId = str(fixture.leagueId);
    const settlementBlockers: string[] = [];
    const sourceDiagnostics: string[] = [];

    // The Summary response is the freshest match-specific source. Resolve sides
    // using ESPN's homeAway field, not the persisted root IDs, which can lag a
    // Summary refresh. Root fields remain a last-resort fallback only.
    const summaryHome = this.sideCandidate(headerCompetitions, 'home');
    const summaryAway = this.sideCandidate(headerCompetitions, 'away');
    const eventHome = this.sideCandidate(fixtureCompetitions, 'home');
    const eventAway = this.sideCandidate(fixtureCompetitions, 'away');
    const boxHome = this.boxscoreSide(summary, 'home');
    const boxAway = this.boxscoreSide(summary, 'away');
    const idFrom = (competitor?: R, box?: { raw: R }): string =>
      str(
        first(
          competitor?.id,
          record(competitor?.team)?.id,
          record(box?.raw.team)?.id,
          box?.raw.teamId,
        ),
      );

    const homeTeamId = str(
      first(
        idFrom(summaryHome),
        idFrom(undefined, boxHome),
        idFrom(eventHome),
        fixture.homeTeamId,
      ),
    );
    const awayTeamId = str(
      first(
        idFrom(summaryAway),
        idFrom(undefined, boxAway),
        idFrom(eventAway),
        fixture.awayTeamId,
      ),
    );
    const homeTeamName = str(
      this.teamName(summaryHome) ??
        this.teamName(eventHome) ??
        boxHome?.teamName ??
        'Home Team',
    );
    const awayTeamName = str(
      this.teamName(summaryAway) ??
        this.teamName(eventAway) ??
        boxAway?.teamName ??
        'Away Team',
    );

    if (!homeTeamId || !awayTeamId) {
      settlementBlockers.push(
        'Home/away team identities could not both be resolved from ESPN Summary data or the canonical fixture.',
      );
    } else if (homeTeamId === awayTeamId) {
      settlementBlockers.push(
        'Home and away sides resolve to the same team ID; settlement is unsafe.',
      );
    }
    if (
      normalize(homeTeamName) &&
      normalize(awayTeamName) &&
      normalize(homeTeamName) === normalize(awayTeamName)
    ) {
      settlementBlockers.push(
        'Home and away team names resolve to the same normalized value; settlement is unsafe.',
      );
    }

    // Root IDs are mirrored fixture fields. A mismatch is diagnostic rather than
    // fatal when the current Summary explicitly identifies both sides.
    const rootHomeId = str(fixture.homeTeamId);
    const rootAwayId = str(fixture.awayTeamId);
    if (summaryHome && rootHomeId && homeTeamId && rootHomeId !== homeTeamId) {
      sourceDiagnostics.push(
        `ROOT_HOME_TEAM_ID_STALE:${rootHomeId}->${homeTeamId}`,
      );
    }
    if (summaryAway && rootAwayId && awayTeamId && rootAwayId !== awayTeamId) {
      sourceDiagnostics.push(
        `ROOT_AWAY_TEAM_ID_STALE:${rootAwayId}->${awayTeamId}`,
      );
    }
    if (
      summaryHome &&
      eventHome &&
      idFrom(summaryHome) &&
      idFrom(eventHome) &&
      idFrom(summaryHome) !== idFrom(eventHome)
    ) {
      sourceDiagnostics.push(
        `EVENT_HOME_TEAM_ID_DIFFERS_FROM_SUMMARY:${idFrom(eventHome)}->${idFrom(summaryHome)}`,
      );
    }
    if (
      summaryAway &&
      eventAway &&
      idFrom(summaryAway) &&
      idFrom(eventAway) &&
      idFrom(summaryAway) !== idFrom(eventAway)
    ) {
      sourceDiagnostics.push(
        `EVENT_AWAY_TEAM_ID_DIFFERS_FROM_SUMMARY:${idFrom(eventAway)}->${idFrom(summaryAway)}`,
      );
    }
    for (const [side, headerSide, boxSide] of [
      ['home', summaryHome, boxHome],
      ['away', summaryAway, boxAway],
    ] as const) {
      const headerId = idFrom(headerSide);
      const boxId = idFrom(undefined, boxSide);
      if (headerId && boxId && headerId !== boxId) {
        settlementBlockers.push(
          `ESPN Summary ${side} team identity conflict: header team ${headerId} differs from boxscore team ${boxId}.`,
        );
      }
      const headerName = normalize(this.teamName(headerSide));
      const boxName = normalize(boxSide?.teamName);
      if (
        !headerId &&
        !boxId &&
        headerName &&
        boxName &&
        headerName !== boxName
      ) {
        settlementBlockers.push(
          `ESPN Summary ${side} team name conflict between header and boxscore.`,
        );
      }
    }

    const rawEvents = this.extractEvents(summary, fixtureCompetitions);
    // ESPN's event team ID on an own-goal detail identifies the team that scored
    // into its own net; the credited scoring team is the opponent.
    const events = {
      ...rawEvents,
      goals: rawEvents.goals.map((goal) => ({
        ...goal,
        creditedTeamId: goal.ownGoal
          ? goal.teamId === homeTeamId
            ? awayTeamId
            : goal.teamId === awayTeamId
              ? homeTeamId
              : undefined
          : goal.teamId,
      })),
    };

    // Never prefer a root 0-0 merely because it is present. Read both scores as
    // a pair from one source, preferring Summary header, Summary boxscore,
    // current event competitors, and only then the root mirror. Contradictory
    // Summary-level sources are blocked instead of guessed.
    const scoreResolution = this.readScorePair(
      fixture,
      summary,
      fixtureCompetitions,
      headerCompetitions,
    );
    const reportedHomeScore = scoreResolution.home;
    const reportedAwayScore = scoreResolution.away;
    sourceDiagnostics.push(...scoreResolution.diagnostics);
    settlementBlockers.push(...scoreResolution.blockers);

    const isFinished = this.isFinished(
      fixture,
      payload,
      fixtureCompetitions,
      headerCompetitions,
    );
    const afterExtraTime = this.isAfterExtraTime(
      fixture,
      payload,
      summary,
      fixtureCompetitions,
      headerCompetitions,
    );
    let regulationResolution = afterExtraTime
      ? this.readRegulationScorePair(
          fixtureCompetitions,
          headerCompetitions,
          summary,
          reportedHomeScore,
          reportedAwayScore,
        )
      : {
          home: reportedHomeScore,
          away: reportedAwayScore,
          blockers: [],
          diagnostics: [],
        };
    settlementBlockers.push(...regulationResolution.blockers);
    sourceDiagnostics.push(...regulationResolution.diagnostics);
    if (
      afterExtraTime &&
      (regulationResolution.home === undefined ||
        regulationResolution.away === undefined)
    ) {
      const eventRegulationScore = this.regulationScoreFromGoalEvents(
        events.goals,
        homeTeamId,
        awayTeamId,
        reportedHomeScore,
        reportedAwayScore,
      );
      if (eventRegulationScore) {
        regulationResolution = {
          ...regulationResolution,
          home: eventRegulationScore.home,
          away: eventRegulationScore.away,
          diagnostics: [
            ...regulationResolution.diagnostics,
            'REGULATION_SCORE_DERIVED_FROM_COMPLETE_GOAL_EVENTS',
          ],
        };
        sourceDiagnostics.push(
          'REGULATION_SCORE_DERIVED_FROM_COMPLETE_GOAL_EVENTS',
        );
      }
    }
    const homeScore = afterExtraTime
      ? regulationResolution.home
      : reportedHomeScore;
    const awayScore = afterExtraTime
      ? regulationResolution.away
      : reportedAwayScore;
    const statsResult = this.extractTeamStats(
      payload,
      summary,
      fixtureCompetitions,
      headerCompetitions,
      homeTeamId,
      awayTeamId,
    );
    const stats = statsResult.stats;
    const halfScores = this.extractHalfScores(
      fixture,
      payload,
      summary,
      fixtureCompetitions,
      headerCompetitions,
      homeTeamId,
      awayTeamId,
      homeScore,
      awayScore,
      events.goals,
      afterExtraTime,
    );
    sourceDiagnostics.push(...(halfScores.diagnostics ?? []));
    const playerStatsData = this.extractPlayerStats(summary);
    const goalsTotal = (reportedHomeScore ?? 0) + (reportedAwayScore ?? 0);
    // Event lists are complete only when they reconcile with the official score
    // both overall and by credited team. A matching aggregate count alone can
    // still hide a missing team ID or a goal assigned to the wrong side, which
    // would make player and half-time settlement unsafe.
    const creditedHomeGoals = events.goals.filter(
      (goal) => goal.creditedTeamId === homeTeamId,
    ).length;
    const creditedAwayGoals = events.goals.filter(
      (goal) => goal.creditedTeamId === awayTeamId,
    ).length;
    const everyGoalHasKnownCreditedTeam = events.goals.every(
      (goal) =>
        Boolean(goal.creditedTeamId) &&
        (goal.creditedTeamId === homeTeamId ||
          goal.creditedTeamId === awayTeamId),
    );
    const goalEventsComplete =
      Boolean(homeTeamId && awayTeamId) &&
      reportedHomeScore !== undefined &&
      reportedAwayScore !== undefined &&
      events.goals.length === goalsTotal &&
      everyGoalHasKnownCreditedTeam &&
      creditedHomeGoals === reportedHomeScore &&
      creditedAwayGoals === reportedAwayScore;

    const sourceSummaryCollectedAt = this.toDate(
      payload.summaryCollectedAt ?? fixture.collectedAt,
    );
    const sourceFingerprint = createSettlementSourceFingerprint(fixture);

    const homeStats = stats[homeTeamId] ?? {};
    const awayStats = stats[awayTeamId] ?? {};
    // Penalty kicks taken are not a reliable count of penalties awarded: a
    // penalty may be awarded without a kick being taken, and retakes can differ.
    // Use event details or explicitly labelled award/attempt statistics only.
    const penaltiesFromStats = this.sumIfPresent(
      this.getAny(homeStats, ['penaltiesAwarded']),
      this.getAny(awayStats, ['penaltiesAwarded']),
    );
    const penaltiesFromEvents = events.raw.filter(
      (event) => event.penalty,
    ).length;
    const penaltiesAwarded =
      penaltiesFromEvents > 0 ? penaltiesFromEvents : penaltiesFromStats;
    const redFromStats = this.sumIfPresent(
      this.getAny(homeStats, ['redCards', 'redCard']),
      this.getAny(awayStats, ['redCards', 'redCard']),
    );
    const yellowFromStats = this.sumIfPresent(
      this.getAny(homeStats, ['yellowCards', 'yellowCard']),
      this.getAny(awayStats, ['yellowCards', 'yellowCard']),
    );
    const observedRedCards = events.cards.filter((event) => event.red).length;
    const observedYellowCards = events.cards.filter(
      (event) => event.yellow,
    ).length;
    // Positive event evidence can establish that at least one card occurred.
    // Absence from a partial event feed cannot establish a zero total, so zero
    // values are accepted only from team statistics that cover both teams.
    const redCards =
      redFromStats !== undefined
        ? redFromStats
        : observedRedCards > 0
          ? observedRedCards
          : undefined;
    const yellowCards =
      yellowFromStats !== undefined
        ? yellowFromStats
        : observedYellowCards > 0
          ? observedYellowCards
          : undefined;
    const ownGoals = goalEventsComplete
      ? events.goals.filter((goal) => goal.ownGoal).length
      : undefined;

    return {
      eventId,
      leagueId,
      fixtureDate: this.toDate(fixture.fixtureDate),
      homeTeamId,
      awayTeamId,
      homeTeamName,
      awayTeamName,
      isFinished,
      afterExtraTime,
      regulationScoreAvailable:
        homeScore !== undefined && awayScore !== undefined,
      homeGoals: homeScore,
      awayGoals: awayScore,
      halfTimeHomeGoals: halfScores.halfHome,
      halfTimeAwayGoals: halfScores.halfAway,
      secondHalfHomeGoals: halfScores.secondHome,
      secondHalfAwayGoals: halfScores.secondAway,
      periodScoresAvailable: halfScores.available,
      goalEventsComplete,
      eventDetailsAvailable: events.detailsAvailable,
      homeStats,
      awayStats,
      settlementBlockers: [...new Set(settlementBlockers)],
      sourceDiagnostics: [...new Set(sourceDiagnostics)],
      conflictingStats: statsResult.conflictingStats,
      scoreSource: scoreResolution.source,
      playerStats: playerStatsData.stats,
      playerNames: playerStatsData.names,
      goals: events.goals,
      cards: events.cards,
      penaltiesAwarded,
      ownGoals,
      redCards,
      yellowCards,
      sourceSummaryCollectedAt,
      sourceFingerprint,
    };
  }

  private isAfterExtraTime(
    fixture: R,
    payload: R,
    summary: R,
    comps: R[],
    headerComps: R[],
  ): boolean {
    const statusNames = [
      fixture.status,
      fixture.statusDetail,
      fixture.statusShortDetail,
      record(record(payload.status)?.type)?.name,
      record(record(payload.status)?.type)?.state,
      record(record(payload.status)?.type)?.description,
      record(record(payload.status)?.type)?.detail,
      record(summary.header)?.status,
    ].map(str);
    for (const competition of [...comps, ...headerComps]) {
      const status = record(competition.status) ?? {};
      const type = record(status.type) ?? {};
      statusNames.push(
        str(type.name),
        str(type.description),
        str(type.detail),
        str(status.detail),
        str(status.shortDetail),
      );
    }
    if (
      statusNames.some((value) =>
        /after\s*extra\s*time|extra.?time|penalty.?shoot.?out|full.?time.?penalt|\bAET\b|\bFT\s*PEN\b/i.test(
          value,
        ),
      )
    )
      return true;

    // ESPN commonly includes one line-score item for each match period when a
    // match reaches extra time. This catches payloads whose status is only Final.
    const candidates = [
      this.sideCandidate(headerComps, 'home'),
      this.sideCandidate(headerComps, 'away'),
      this.sideCandidate(comps, 'home'),
      this.sideCandidate(comps, 'away'),
      this.boxscoreSide(summary, 'home')?.raw,
      this.boxscoreSide(summary, 'away')?.raw,
    ];
    return candidates.some(
      (candidate) => this.lineScores(candidate).length >= 3,
    );
  }

  private regulationScoreFromGoalEvents(
    goals: SettlementEventFacts['goals'],
    homeTeamId: string,
    awayTeamId: string,
    reportedHome?: number,
    reportedAway?: number,
  ): { home: number; away: number } | undefined {
    if (
      reportedHome === undefined ||
      reportedAway === undefined ||
      !homeTeamId ||
      !awayTeamId ||
      goals.length !== reportedHome + reportedAway ||
      !goals.every(
        (goal) =>
          goal.minute !== undefined &&
          Boolean(goal.creditedTeamId) &&
          (goal.creditedTeamId === homeTeamId ||
            goal.creditedTeamId === awayTeamId),
      ) ||
      goals.filter((goal) => goal.creditedTeamId === homeTeamId).length !==
        reportedHome ||
      goals.filter((goal) => goal.creditedTeamId === awayTeamId).length !==
        reportedAway
    )
      return undefined;

    // Added time 90+N is encoded as 90.0N, so a 90.99 boundary includes all
    // regulation stoppage time and excludes extra-time goals starting at 91.
    const regulationGoals = goals.filter((goal) => goal.minute! <= 90.99);
    const home = regulationGoals.filter(
      (goal) => goal.creditedTeamId === homeTeamId,
    ).length;
    const away = regulationGoals.filter(
      (goal) => goal.creditedTeamId === awayTeamId,
    ).length;
    return { home, away };
  }

  private readRegulationScorePair(
    fixtureComps: R[],
    headerComps: R[],
    summary: R,
    reportedHome?: number,
    reportedAway?: number,
  ): {
    home?: number;
    away?: number;
    source?: string;
    blockers: string[];
    diagnostics: string[];
  } {
    const blockers: string[] = [];
    const diagnostics: string[] = [];
    if (reportedHome === undefined || reportedAway === undefined) {
      return { blockers, diagnostics };
    }

    const candidates: Array<{
      name: string;
      home?: R;
      away?: R;
      priority: number;
    }> = [
      {
        name: 'summary.header.competitors',
        home: this.sideCandidate(headerComps, 'home'),
        away: this.sideCandidate(headerComps, 'away'),
        priority: 0,
      },
      {
        name: 'summary.boxscore.teams',
        home: this.boxscoreSide(summary, 'home')?.raw,
        away: this.boxscoreSide(summary, 'away')?.raw,
        priority: 1,
      },
      {
        name: 'payload.competitions',
        home: this.sideCandidate(fixtureComps, 'home'),
        away: this.sideCandidate(fixtureComps, 'away'),
        priority: 2,
      },
    ];
    const resolve = (candidate: {
      name: string;
      home?: R;
      away?: R;
      priority: number;
    }) => {
      if (!candidate.home || !candidate.away) return undefined;
      const homeRawLines = array(candidate.home.linescores).map(
        (item) => record(item) ?? { value: item },
      );
      const awayRawLines = array(candidate.away.linescores).map(
        (item) => record(item) ?? { value: item },
      );
      const homeLines = this.lineScores(candidate.home);
      const awayLines = this.lineScores(candidate.away);
      if (
        homeLines.length < 2 ||
        awayLines.length < 2 ||
        homeRawLines.length < 2 ||
        awayRawLines.length < 2 ||
        !this.hasExplicitFirstTwoPeriods(homeRawLines) ||
        !this.hasExplicitFirstTwoPeriods(awayRawLines)
      )
        return undefined;
      const home = homeLines[0] + homeLines[1];
      const away = awayLines[0] + awayLines[1];
      if (home > reportedHome || away > reportedAway) return undefined;
      return {
        home,
        away,
        source: candidate.name,
        priority: candidate.priority,
      };
    };

    const valid = candidates.map(resolve).filter(Boolean) as Array<{
      home: number;
      away: number;
      source: string;
      priority: number;
    }>;
    if (!valid.length) return { blockers, diagnostics };
    const chosen = valid[0];

    // Summary header and boxscore are both Summary-level match data. If each
    // provides a well-formed regulation score but they disagree, do not settle
    // any score-based market from an arbitrary half-time/extra-time interpretation.
    const summarySources = valid.filter((item) => item.priority <= 1);
    if (summarySources.length > 1) {
      const firstSummary = summarySources[0];
      const conflictingSummary = summarySources.find(
        (item) =>
          item.home !== firstSummary.home || item.away !== firstSummary.away,
      );
      if (conflictingSummary) {
        diagnostics.push(
          `SUMMARY_REGULATION_SCORE_CONFLICT:${firstSummary.source} ${firstSummary.home}-${firstSummary.away} differs from ${conflictingSummary.source} ${conflictingSummary.home}-${conflictingSummary.away}`,
        );
        return { blockers, diagnostics };
      }
    }
    const eventMirror = valid.find((item) => item.priority === 2);
    const summaryChosen = valid.find((item) => item.priority <= 1);
    if (
      eventMirror &&
      summaryChosen &&
      (eventMirror.home !== summaryChosen.home ||
        eventMirror.away !== summaryChosen.away)
    ) {
      diagnostics.push(
        `EVENT_REGULATION_SCORE_DIFFERS_FROM_SUMMARY:${eventMirror.home}-${eventMirror.away}->${summaryChosen.home}-${summaryChosen.away}`,
      );
    }
    return {
      home: chosen.home,
      away: chosen.away,
      source: chosen.source,
      blockers,
      diagnostics,
    };
  }

  private hasExplicitFirstTwoPeriods(lines: R[]): boolean {
    const periodValue = (line: R): unknown => {
      const period = record(line.period) ?? {};
      return first(
        line.periodNumber,
        line.period,
        line.periodId,
        line.sequence,
        period.number,
        period.id,
        period.name,
        line.periodName,
        line.label,
      );
    };
    const toPeriod = (value: unknown): number | undefined => {
      const numeric = num(value);
      if (numeric !== undefined && Number.isInteger(numeric)) return numeric;
      const text = normalize(value);
      if (/^(first|firsthalf|periodone|one|1sthalf)$/.test(text)) return 1;
      if (/^(second|secondhalf|periodtwo|two|2ndhalf)$/.test(text)) return 2;
      return undefined;
    };
    return (
      lines.length >= 2 &&
      toPeriod(periodValue(lines[0])) === 1 &&
      toPeriod(periodValue(lines[1])) === 2
    );
  }

  private isFinished(
    fixture: R,
    payload: R,
    comps: R[],
    headerComps: R[],
  ): boolean {
    type StatusGroup = {
      names: string[];
      types: R[];
    };

    const statusGroupFromCompetitions = (items: R[]): StatusGroup => {
      const names: string[] = [];
      const types: R[] = [];
      for (const competition of items) {
        const status = record(competition.status) ?? {};
        const type = record(status.type) ?? {};
        types.push(type);
        names.push(
          str(type.name),
          str(type.state),
          str(type.description),
          str(type.detail),
          str(status.detail),
          str(status.shortDetail),
        );
      }
      return { names: names.filter(Boolean), types };
    };

    const payloadStatus = record(payload.status) ?? {};
    const payloadStatusType = record(payloadStatus.type) ?? {};
    const payloadStatusGroup: StatusGroup = {
      names: [
        str(payloadStatusType.name),
        str(payloadStatusType.state),
        str(payloadStatusType.description),
        str(payloadStatusType.detail),
        str(payloadStatus.detail),
        str(payloadStatus.shortDetail),
      ].filter(Boolean),
      types: [payloadStatusType],
    };
    const rootStatusGroup: StatusGroup = {
      names: [
        str(fixture.status),
        str(fixture.statusDetail),
        str(fixture.statusShortDetail),
      ].filter(Boolean),
      types: [],
    };

    const classification = (group: StatusGroup): 'FINISHED' | 'NOT_FINISHED' | 'UNKNOWN' => {
      const names = group.names.map(normalize).filter(Boolean);
      if (names.length === 0 && !group.types.some((type) => typeof type.completed === 'boolean')) {
        return 'UNKNOWN';
      }

      // A specific provider cancellation/postponement status must never be
      // converted into a loss or win, even when a stale completed flag exists.
      if (group.names.some((name) =>
        /cancel(?:led|ed)?|postponed|abandoned|suspended|interrupted|delayed|statuscanceled|statuscancelled/i.test(name),
      )) {
        return 'NOT_FINISHED';
      }

      const explicitCompleted = group.types.some((type) => type.completed === true);
      const finalTokens = new Set([
        'ft',
        'ftaet',
        'ftet',
        'ftpen',
        'aet',
        'finished',
        'completed',
        'final',
        'statusfinal',
        'statusfulltime',
        'statuspost',
        'post',
      ]);
      const explicitFinal = explicitCompleted || names.some((name) =>
        finalTokens.has(name) || /fulltime|afterextratime|afterpenalt|statuspost/.test(name),
      );
      if (explicitFinal) return 'FINISHED';

      // A known current/pre-match state is authoritative for its source group.
      // It should override stale root-level completed flags, not a final Summary.
      if (names.some((name) =>
        /scheduled|notstarted|pre|inprogress|live|halftime|firsthalf|secondhalf|endperiod|delayed|postponed|cancelled|canceled|abandoned|suspended|interrupted/.test(name),
      )) {
        return 'NOT_FINISHED';
      }
      if (group.types.some((type) => type.completed === false)) return 'NOT_FINISHED';
      return 'UNKNOWN';
    };

    // Summary header is the freshest event-specific source. Do not let an old
    // fixture.status='SCHEDULED' overwrite an explicit Summary final status.
    const orderedGroups = [
      statusGroupFromCompetitions(headerComps),
      statusGroupFromCompetitions(comps),
      payloadStatusGroup,
      rootStatusGroup,
    ];
    for (const group of orderedGroups) {
      const result = classification(group);
      if (result !== 'UNKNOWN') return result === 'FINISHED';
    }

    // Last-resort fallback only when no provider status source gives a verdict.
    return fixture.completed === true;
  }

  private sideCandidate(
    competitions: R[],
    side: 'home' | 'away',
  ): R | undefined {
    for (const competition of competitions) {
      const competitors = array(competition.competitors)
        .map(record)
        .filter(Boolean) as R[];
      const found = competitors.find(
        (item) => str(item.homeAway).toLowerCase() === side,
      );
      if (found) return found;
    }
    return undefined;
  }

  private teamName(competitor?: R): string | undefined {
    if (!competitor) return undefined;
    const team = record(competitor.team) ?? {};
    const name = first(
      team.displayName,
      team.name,
      team.shortDisplayName,
      competitor.displayName,
      competitor.name,
    );
    return name ? str(name) : undefined;
  }

  private readScorePair(
    fixture: R,
    summary: R,
    fixtureComps: R[],
    headerComps: R[],
  ): {
    home?: number;
    away?: number;
    source?: string;
    blockers: string[];
    diagnostics: string[];
  } {
    const blockers: string[] = [];
    const diagnostics: string[] = [];
    // Football scores and period goal totals must be non-negative integers.
    // Accepting a decimal score from malformed provider data can silently turn
    // a corrupt payload into a valid-looking settlement result.
    const validScore = (value: unknown): number | undefined =>
      footballScore(value);
    const score = (competitor?: R): number | undefined => {
      if (!competitor) return undefined;
      const direct = validScore(
        competitor.score ?? record(competitor.team)?.score,
      );
      if (direct !== undefined) return direct;
      const statistics = array(competitor.statistics)
        .map(record)
        .filter(Boolean) as R[];
      const goals = statistics.find((item) =>
        ['totalgoals', 'goals', 'goalsscored'].includes(
          normalize(item.name ?? item.label ?? item.abbreviation),
        ),
      );
      return validScore(goals?.displayValue ?? goals?.value ?? goals?.stat);
    };
    const boxScore = (side: 'home' | 'away'): number | undefined => {
      const row = this.boxscoreSide(summary, side)?.raw;
      if (!row) return undefined;
      const direct = validScore(row.score ?? record(row.team)?.score);
      if (direct !== undefined) return direct;
      const statistics = array(row.statistics)
        .map(record)
        .filter(Boolean) as R[];
      const goals = statistics.find((item) =>
        ['totalgoals', 'goals', 'goalsscored'].includes(
          normalize(item.name ?? item.label ?? item.abbreviation),
        ),
      );
      return validScore(goals?.displayValue ?? goals?.value ?? goals?.stat);
    };

    const sources = [
      {
        name: 'summary.header.competitors',
        home: score(this.sideCandidate(headerComps, 'home')),
        away: score(this.sideCandidate(headerComps, 'away')),
        priority: 0,
      },
      {
        name: 'summary.boxscore.teams',
        home: boxScore('home'),
        away: boxScore('away'),
        priority: 1,
      },
      {
        name: 'payload.competitions',
        home: score(this.sideCandidate(fixtureComps, 'home')),
        away: score(this.sideCandidate(fixtureComps, 'away')),
        priority: 2,
      },
      {
        name: 'fixture.root',
        home: validScore(fixture.homeScore),
        away: validScore(fixture.awayScore),
        priority: 3,
      },
    ].map((item) => ({
      ...item,
      home: item.home !== undefined && item.home >= 0 ? item.home : undefined,
      away: item.away !== undefined && item.away >= 0 ? item.away : undefined,
    }));

    const chosen = sources.find(
      (item) => item.home !== undefined && item.away !== undefined,
    );
    if (!chosen) {
      return { blockers, diagnostics, source: undefined };
    }
    if (chosen.priority === 3) {
      blockers.push(
        'Only the persisted root fixture score is available; no paired score was found in the ESPN Summary or event competitors. Refresh the Summary before settling this fixture.',
      );
    }

    // If header and boxscore each provide complete, contradictory scores, the
    // Summary itself is internally inconsistent. Do not guess which market data
    // is right. Other mirrors are allowed to lag and are noted, not promoted.
    const header = sources[0];
    const box = sources[1];
    if (
      header.home !== undefined &&
      header.away !== undefined &&
      box.home !== undefined &&
      box.away !== undefined &&
      (header.home !== box.home || header.away !== box.away)
    ) {
      blockers.push(
        `ESPN Summary score conflict: header ${header.home}-${header.away} differs from boxscore ${box.home}-${box.away}.`,
      );
    }

    for (const other of sources) {
      if (other === chosen || other.priority <= chosen.priority) continue;
      if (other.home === undefined && other.away === undefined) continue;
      if (other.home !== undefined && other.home !== chosen.home) {
        const note = `${other.name} home score ${other.home} differs from selected ${chosen.name} home score ${chosen.home}.`;
        if (other.name === 'fixture.root')
          diagnostics.push(
            `ROOT_HOME_SCORE_STALE:${other.home}->${chosen.home}`,
          );
        else diagnostics.push(note);
      }
      if (other.away !== undefined && other.away !== chosen.away) {
        const note = `${other.name} away score ${other.away} differs from selected ${chosen.name} away score ${chosen.away}.`;
        if (other.name === 'fixture.root')
          diagnostics.push(
            `ROOT_AWAY_SCORE_STALE:${other.away}->${chosen.away}`,
          );
        else diagnostics.push(note);
      }
    }

    // A newer Summary header can itself be missing one side. If the pair had to
    // fall back to a lower source, a contradictory partial header score is still
    // a blocker, because it may represent a newer result that was only partly saved.
    if (chosen.priority > 0) {
      if (header.home !== undefined && header.home !== chosen.home) {
        blockers.push(
          `Partial Summary header home score ${header.home} conflicts with selected score ${chosen.home}.`,
        );
      }
      if (header.away !== undefined && header.away !== chosen.away) {
        blockers.push(
          `Partial Summary header away score ${header.away} conflicts with selected score ${chosen.away}.`,
        );
      }
    }

    return {
      home: chosen.home,
      away: chosen.away,
      source: chosen.name,
      blockers,
      diagnostics,
    };
  }

  private boxscoreSide(
    summary: R,
    side: 'home' | 'away',
  ): { raw: R; teamName?: string } | undefined {
    const boxscore = record(summary.boxscore) ?? {};
    for (const rowValue of array(boxscore.teams)) {
      const row = record(rowValue) ?? {};
      if (str(row.homeAway).toLowerCase() !== side) continue;
      const team = record(row.team) ?? {};
      return {
        raw: row,
        teamName:
          str(first(team.displayName, team.name, team.shortDisplayName)) ||
          undefined,
      };
    }
    return undefined;
  }

  private extractTeamStats(
    _payload: R,
    summary: R,
    fixtureComps: R[],
    headerComps: R[],
    homeTeamId: string,
    awayTeamId: string,
  ): {
    stats: Record<string, Record<string, number>>;
    conflictingStats: string[];
  } {
    const result: Record<string, Record<string, number>> = {};
    const conflicting = new Set<string>();
    const sideFor = (raw: R): 'home' | 'away' | undefined => {
      const homeAway = str(raw.homeAway).toLowerCase();
      if (homeAway === 'home' || homeAway === 'away') return homeAway;
      const id = str(raw.id ?? raw.teamId ?? record(raw.team)?.id);
      if (id && id === homeTeamId) return 'home';
      if (id && id === awayTeamId) return 'away';
      return undefined;
    };
    const put = (
      side: 'home' | 'away' | undefined,
      statName: unknown,
      rawValue: unknown,
      source: string,
    ) => {
      if (!side) return;
      const key = this.statKey(statName);
      const value = this.statValue(rawValue, key);
      if (!key || value === undefined) return;
      const teamId = side === 'home' ? homeTeamId : awayTeamId;
      if (!teamId) return;
      result[teamId] ??= {};
      const existing = result[teamId][key];
      if (existing === undefined) {
        result[teamId][key] = value;
      } else if (existing !== value) {
        conflicting.add(`${side}:${key}`);
        // First source is Summary boxscore, which is the preferred stat source.
        // Never silently replace it with a stale mirrored event/header value.
        void source;
      }
    };
    const scanRows = (
      rows: unknown[],
      source: string,
      getStatistics: (row: R) => unknown[],
    ) => {
      for (const value of rows) {
        const row = record(value) ?? {};
        const side = sideFor(row);
        for (const statValue of getStatistics(row)) {
          const stat = record(statValue) ?? {};
          put(
            side,
            stat.name ??
              stat.label ??
              stat.abbreviation ??
              stat.shortDisplayName,
            stat.displayValue ?? stat.value ?? stat.stat,
            source,
          );
        }
      }
    };

    const boxscore = record(summary.boxscore) ?? {};
    scanRows(array(boxscore.teams), 'summary.boxscore.teams', (row) =>
      array(row.statistics),
    );

    // The Summary header is second priority; the stored event competitors are
    // last because they may be an older scoreboard snapshot.
    for (const compValue of headerComps) {
      const comp = record(compValue) ?? {};
      scanRows(array(comp.competitors), 'summary.header.competitors', (row) =>
        array(row.statistics),
      );
    }
    for (const compValue of fixtureComps) {
      const comp = record(compValue) ?? {};
      scanRows(array(comp.competitors), 'payload.competitions', (row) =>
        array(row.statistics),
      );
    }

    return { stats: result, conflictingStats: [...conflicting].sort() };
  }

  private extractEvents(
    summary: R,
    comps: R[],
  ): {
    goals: SettlementEventFacts['goals'];
    cards: SettlementEventFacts['cards'];
    raw: Array<{ penalty: boolean }>;
    detailsAvailable: boolean;
  } {
    const candidates: Array<{ value: unknown; source: string }> = [];
    for (const comp of comps) {
      if (Array.isArray(comp.details))
        candidates.push({ value: comp.details, source: 'fixture.details' });
    }
    const summaryHeader = record(summary.header) ?? {};
    for (const compValue of array(summaryHeader.competitions)) {
      const comp = record(compValue) ?? {};
      if (Array.isArray(comp.details))
        candidates.push({
          value: comp.details,
          source: 'summary.header.details',
        });
    }
    if (Array.isArray(summary.keyEvents))
      candidates.push({
        value: summary.keyEvents,
        source: 'summary.keyEvents',
      });
    if (Array.isArray(summary.commentary))
      candidates.push({
        value: summary.commentary,
        source: 'summary.commentary',
      });

    const goals: SettlementEventFacts['goals'] = [];
    const cards: SettlementEventFacts['cards'] = [];
    const raw: Array<{ penalty: boolean }> = [];
    const seen = new Set<string>();
    let order = 0;
    let detailsAvailable = false;

    for (const candidate of candidates) {
      const items = array(candidate.value).map(record).filter(Boolean) as R[];
      if (!items.length) continue;
      if (
        candidate.source === 'fixture.details' ||
        candidate.source === 'summary.header.details'
      )
        detailsAvailable = true;
      for (const item of items) {
        const type = record(item.type) ?? {};
        const typeText = str(
          first(
            type.text,
            type.shortName,
            type.name,
            item.text,
            item.shortText,
          ),
        );
        const period = record(item.period) ?? {};
        const periodType = record(period.type) ?? {};
        const eventContext = [
          typeText,
          str(item.description),
          str(item.shortDescription),
          str(item.displayValue),
          str(period.name),
          str(period.displayValue),
          str(periodType.name),
          str(periodType.description),
          str(item.periodType),
        ].join(' ');
        const isShootout =
          item.shootout === true ||
          item.penaltyShootout === true ||
          /penalty[ -]?shoot.?out|shoot.?out|kicks from the penalty mark/i.test(
            eventContext,
          );
        if (isShootout) continue;
        const team = record(item.team) ?? {};
        const teamId = str(team.id ?? item.teamId) || undefined;
        const clock = record(item.clock) ?? {};
        const minute = this.eventMinute(
          clock.value,
          clock.displayValue ?? item.time ?? item.minute,
        );
        const people = array(item.athletesInvolved ?? item.athletes)
          .map(record)
          .filter(Boolean) as R[];
        const playerIds = people
          .map((person) => {
            const athlete = record(person.athlete) ?? {};
            return str(first(person.id, athlete.id));
          })
          .filter(Boolean);
        const ownGoal = item.ownGoal === true || /own\s*goal/i.test(typeText);
        const penalty =
          item.penaltyKick === true || /penalt(?:y|ies)/i.test(typeText);
        const red =
          item.redCard === true || /red\s*card|sent\s*off/i.test(typeText);
        const yellow =
          item.yellowCard === true || /yellow\s*card|booked/i.test(typeText);
        const scoringPlay = item.scoringPlay === true;
        const isGoal =
          scoringPlay ||
          ownGoal ||
          /^(goal|goal\s*[-:]|penalty\s*goal|own\s*goal)/i.test(typeText);
        const isCard = red || yellow;
        if (!isGoal && !isCard && !penalty) continue;
        // ESPN may repeat the same event in fixture details, Summary header,
        // keyEvents and commentary with different provider IDs or display text.
        // Track both the provider ID and a normalized event signature so duplicate
        // cards cannot inflate a lower-bound count and falsely settle a market.
        const providerId = str(item.id);
        const signature = `${teamId ?? ''}:${minute ?? 'na'}:${[...playerIds].sort().join(',')}:${isGoal}:${ownGoal}:${red}:${yellow}:${penalty}`;
        const providerKey = providerId ? `id:${providerId}` : undefined;
        const signatureKey = `event:${signature}`;
        if ((providerKey && seen.has(providerKey)) || seen.has(signatureKey))
          continue;
        if (providerKey) seen.add(providerKey);
        seen.add(signatureKey);
        const stable = providerId || signatureKey;
        const sequence = order++;
        raw.push({ penalty });
        if (isGoal) {
          goals.push({
            eventKey: stable,
            teamId,
            creditedTeamId: teamId,
            playerIds: ownGoal ? [] : playerIds,
            minute,
            order: sequence,
            ownGoal,
            penalty,
          });
        }
        if (isCard) {
          cards.push({ playerIds, teamId, red, yellow, minute });
        }
      }
    }

    goals.sort((a, b) => {
      if (a.minute !== undefined && b.minute !== undefined)
        return a.minute - b.minute || a.order - b.order;
      return a.order - b.order;
    });
    cards.sort(
      (a, b) =>
        (a.minute ?? Number.MAX_SAFE_INTEGER) -
        (b.minute ?? Number.MAX_SAFE_INTEGER),
    );
    return { goals, cards, raw, detailsAvailable };
  }

  private extractHalfScores(
    fixture: R,
    payload: R,
    summary: R,
    fixtureComps: R[],
    headerComps: R[],
    homeTeamId: string,
    awayTeamId: string,
    homeFinal?: number,
    awayFinal?: number,
    goals: SettlementEventFacts['goals'] = [],
    afterExtraTime = false,
  ): {
    halfHome?: number;
    halfAway?: number;
    secondHome?: number;
    secondAway?: number;
    available: boolean;
    diagnostics: string[];
  } {
    const diagnostics: string[] = [];
    const candidates: Array<{
      name: string;
      home?: R;
      away?: R;
      priority: number;
    }> = [
      {
        name: 'summary.header.competitors',
        home: this.sideCandidate(headerComps, 'home'),
        away: this.sideCandidate(headerComps, 'away'),
        priority: 0,
      },
      {
        name: 'summary.boxscore.teams',
        home: this.boxscoreSide(summary, 'home')?.raw,
        away: this.boxscoreSide(summary, 'away')?.raw,
        priority: 1,
      },
      {
        name: 'payload.competitions',
        home: this.sideCandidate(fixtureComps, 'home'),
        away: this.sideCandidate(fixtureComps, 'away'),
        priority: 2,
      },
    ];
    const evaluate = (candidate: {
      name: string;
      home?: R;
      away?: R;
      priority: number;
    }) => {
      if (
        !candidate.home ||
        !candidate.away ||
        homeFinal === undefined ||
        awayFinal === undefined
      ) {
        return undefined;
      }
      const homeLines = this.lineScores(candidate.home);
      const awayLines = this.lineScores(candidate.away);
      if (homeLines.length < 2 || awayLines.length < 2) return undefined;

      if (afterExtraTime) {
        const homeRaw = array(candidate.home.linescores).map(
          (item) => record(item) ?? { value: item },
        );
        const awayRaw = array(candidate.away.linescores).map(
          (item) => record(item) ?? { value: item },
        );
        if (
          !this.hasExplicitFirstTwoPeriods(homeRaw) ||
          !this.hasExplicitFirstTwoPeriods(awayRaw) ||
          homeLines[0] + homeLines[1] !== homeFinal ||
          awayLines[0] + awayLines[1] !== awayFinal
        )
          return undefined;
        return {
          name: candidate.name,
          priority: candidate.priority,
          halfHome: homeLines[0],
          halfAway: awayLines[0],
          secondHome: homeLines[1],
          secondAway: awayLines[1],
        };
      }

      const homeSum = homeLines.reduce((sum, value) => sum + value, 0);
      const awaySum = awayLines.reduce((sum, value) => sum + value, 0);
      if (
        homeLines.length === 2 &&
        awayLines.length === 2 &&
        homeSum === homeFinal &&
        awaySum === awayFinal
      ) {
        return {
          name: candidate.name,
          priority: candidate.priority,
          halfHome: homeLines[0],
          halfAway: awayLines[0],
          secondHome: homeLines[1],
          secondAway: awayLines[1],
        };
      }
      // Some feeds supply first-half score then cumulative final score.
      if (
        homeLines[homeLines.length - 1] === homeFinal &&
        awayLines[awayLines.length - 1] === awayFinal
      ) {
        const halfHome = homeLines[0];
        const halfAway = awayLines[0];
        if (halfHome <= homeFinal && halfAway <= awayFinal) {
          return {
            name: candidate.name,
            priority: candidate.priority,
            halfHome,
            halfAway,
            secondHome: homeFinal - halfHome,
            secondAway: awayFinal - halfAway,
          };
        }
      }
      return undefined;
    };

    // Select one complete source pair. Do not combine the home line scores from
    // a stale event snapshot with away line scores from a newer Summary.
    const valid = candidates.map(evaluate).filter(Boolean) as Array<{
      name: string;
      priority: number;
      halfHome: number;
      halfAway: number;
      secondHome: number;
      secondAway: number;
    }>;
    let summaryPeriodConflict = false;
    if (valid.length) {
      const summarySources = valid.filter((item) => item.priority <= 1);
      if (summarySources.length > 1) {
        const firstSummary = summarySources[0];
        const conflict = summarySources.find(
          (item) =>
            item.halfHome !== firstSummary.halfHome ||
            item.halfAway !== firstSummary.halfAway ||
            item.secondHome !== firstSummary.secondHome ||
            item.secondAway !== firstSummary.secondAway,
        );
        if (conflict) {
          summaryPeriodConflict = true;
          diagnostics.push(
            `SUMMARY_HALF_SCORE_CONFLICT:${firstSummary.name} ${firstSummary.halfHome}-${firstSummary.halfAway}/${firstSummary.secondHome}-${firstSummary.secondAway} differs from ${conflict.name} ${conflict.halfHome}-${conflict.halfAway}/${conflict.secondHome}-${conflict.secondAway}`,
          );
        }
      }
      if (!summaryPeriodConflict) {
        const chosen = valid[0];
        const summaryChosen = valid.find((item) => item.priority <= 1);
        const eventMirror = valid.find((item) => item.priority === 2);
        if (
          summaryChosen &&
          eventMirror &&
          (eventMirror.halfHome !== summaryChosen.halfHome ||
            eventMirror.halfAway !== summaryChosen.halfAway ||
            eventMirror.secondHome !== summaryChosen.secondHome ||
            eventMirror.secondAway !== summaryChosen.secondAway)
        ) {
          diagnostics.push(
            `EVENT_HALF_SCORE_DIFFERS_FROM_SUMMARY:${eventMirror.name} differs from ${summaryChosen.name}`,
          );
        }
        return {
          halfHome: chosen.halfHome,
          halfAway: chosen.halfAway,
          secondHome: chosen.secondHome,
          secondAway: chosen.secondAway,
          available: true,
          diagnostics,
        };
      }
    }

    // When period sources conflict or are missing, infer half scores from goals
    // only if the event list fully reconciles to the known period score. For extra
    // time, discard goals after 90+ stoppage time and require every goal timestamp.
    const allGoalEventsHaveMinutes = goals.every(
      (goal) => goal.minute !== undefined,
    );
    const periodGoals = afterExtraTime
      ? goals.filter(
          (goal) => goal.minute !== undefined && goal.minute <= 90.99,
        )
      : goals;
    const goalsReconcileByTeam =
      Boolean(homeTeamId && awayTeamId) &&
      homeFinal !== undefined &&
      awayFinal !== undefined &&
      allGoalEventsHaveMinutes &&
      periodGoals.length === homeFinal + awayFinal &&
      periodGoals.every(
        (goal) =>
          Boolean(goal.creditedTeamId) &&
          (goal.creditedTeamId === homeTeamId ||
            goal.creditedTeamId === awayTeamId),
      ) &&
      periodGoals.filter((goal) => goal.creditedTeamId === homeTeamId)
        .length === homeFinal &&
      periodGoals.filter((goal) => goal.creditedTeamId === awayTeamId)
        .length === awayFinal;
    if (goalsReconcileByTeam) {
      // Added time 45+3 is encoded as 45.03, remaining before second-half minute 46.
      const firstHalf = periodGoals.filter((goal) => (goal.minute ?? 999) < 46);
      const halfHome = firstHalf.filter(
        (goal) => goal.creditedTeamId === homeTeamId,
      ).length;
      const halfAway = firstHalf.filter(
        (goal) => goal.creditedTeamId === awayTeamId,
      ).length;
      return {
        halfHome,
        halfAway,
        secondHome: homeFinal - halfHome,
        secondAway: awayFinal - halfAway,
        available: true,
        diagnostics,
      };
    }

    void fixture;
    void payload;
    return { available: false, diagnostics };
  }

  private lineScores(side?: R): number[] {
    if (!side) return [];
    const direct = array(side.linescores)
      .map((row) => {
        const rec = record(row);
        return footballScore(rec?.displayValue ?? rec?.value ?? row);
      })
      .filter(
        (n): n is number => n !== undefined && Number.isInteger(n) && n >= 0,
      );
    return direct;
  }

  private extractPlayerStats(summary: R): {
    stats: Record<string, Record<string, number>>;
    names: Record<string, string>;
  } {
    const stats: Record<string, Record<string, number>> = {};
    const names: Record<string, string> = {};
    const walk = (
      value: unknown,
      teamId = '',
      inheritedLabels: string[] = [],
    ): void => {
      const row = record(value);
      if (!row) {
        for (const item of array(value)) walk(item, teamId, inheritedLabels);
        return;
      }
      const team = record(row.team) ?? {};
      const activeTeamId = str(team.id ?? row.teamId) || teamId;
      const labels = Array.isArray(row.labels)
        ? row.labels.map(str)
        : inheritedLabels;
      const athlete =
        record(row.athlete) ??
        (row.athleteId ? { id: row.athleteId } : undefined);
      if (athlete) {
        const id = str(athlete.id ?? row.athleteId ?? row.id);
        const name = str(
          first(
            athlete.displayName,
            athlete.fullName,
            athlete.name,
            row.displayName,
            row.name,
          ),
        );
        if (id && name) names[id] = name;
        const values = array(row.stats ?? row.statistics);
        if (id && labels.length && values.length) {
          stats[id] ??= {};
          labels.forEach((label, index) => {
            const statKey = this.statKey(label);
            const statValue = this.statValue(values[index], statKey);
            if (
              statKey &&
              statValue !== undefined &&
              stats[id][statKey] === undefined
            )
              stats[id][statKey] = statValue;
          });
        }
      }
      // ESPN provider variants sometimes encode the athlete directly as the record itself.
      if (
        row.id &&
        (row.displayName || row.fullName) &&
        Array.isArray(row.stats) &&
        labels.length
      ) {
        const id = str(row.id);
        names[id] = str(row.displayName ?? row.fullName);
        stats[id] ??= {};
        labels.forEach((label, index) => {
          const statKey = this.statKey(label);
          const statValue = this.statValue(row.stats?.[index], statKey);
          if (
            statKey &&
            statValue !== undefined &&
            stats[id][statKey] === undefined
          )
            stats[id][statKey] = statValue;
        });
      }
      for (const [key, child] of Object.entries(row)) {
        if (key === 'team') continue;
        walk(child, activeTeamId, labels);
      }
    };
    walk(summary);
    return { stats, names };
  }

  private statKey(value: unknown): string {
    const valueKey = normalize(value);
    const aliases: Record<string, string> = {
      totalgoals: 'goals',
      goals: 'goals',
      goal: 'goals',
      g: 'goals',
      goalassists: 'assists',
      assists: 'assists',
      assist: 'assists',
      a: 'assists',
      totalshots: 'shots',
      shots: 'shots',
      shot: 'shots',
      sh: 'shots',
      shotstarget: 'shotsontarget',
      shotson: 'shotsontarget',
      shotsontarget: 'shotsontarget',
      totalshotsontarget: 'shotsontarget',
      shotontarget: 'shotsontarget',
      shotsontargets: 'shotsontarget',
      sog: 'shotsontarget',
      yellowcards: 'yellowcards',
      yellowcard: 'yellowcards',
      yc: 'yellowcards',
      redcards: 'redcards',
      redcard: 'redcards',
      rc: 'redcards',
      foulscommitted: 'fouls',
      fouls: 'fouls',
      fc: 'fouls',
      woncorners: 'corners',
      cornerkicks: 'corners',
      corners: 'corners',
      cw: 'corners',
      offsides: 'offsides',
      offside: 'offsides',
      possessionpct: 'possession',
      possession: 'possession',
      pp: 'possession',
      penaltykickshots: 'penaltykickshots',
      penaltykickgoals: 'penaltykickgoals',
      totalpasses: 'passes',
      passes: 'passes',
      accuratepasses: 'accuratepasses',
      appearances: 'appearances',
      minsplayed: 'minutesplayed',
      minutesplayed: 'minutesplayed',
    };
    return aliases[valueKey] ?? valueKey;
  }

  private statValue(value: unknown, key: string): number | undefined {
    const raw = record(value);
    let parsed = num(raw?.displayValue ?? raw?.value ?? raw?.stat ?? value);
    if (parsed === undefined) return undefined;
    // ESPN sometimes reports percentages as 0.7 for 70%; keep the original scale only when field is an explicit percentage fraction.
    if (key === 'possession' && parsed > 0 && parsed <= 1) parsed *= 100;
    return parsed;
  }

  private getAny(
    stats: Record<string, number>,
    keys: string[],
  ): number | undefined {
    for (const key of keys) {
      const value = stats[this.statKey(key)];
      if (value !== undefined) return value;
    }
    return undefined;
  }

  private sumIfPresent(a?: number, b?: number): number | undefined {
    return a !== undefined && b !== undefined ? a + b : undefined;
  }

  private eventMinute(value: unknown, display: unknown): number | undefined {
    // Prefer ESPN's display minute (e.g. 55' or 45'+3') over its clock value,
    // which is elapsed seconds and can floor one minute earlier.
    const text = str(display);
    const match = text.match(/(\d{1,3})/);
    if (match) {
      const base = Number(match[1]);
      const extra = text.match(/\+\s*(\d{1,2})/);
      // Use hundredths for added time: 45+3 becomes 45.03, not minute 48.
      return base + (extra ? Number(extra[1]) / 100 : 0);
    }
    const numeric = num(value);
    if (numeric !== undefined && numeric >= 0) {
      const seconds = numeric > 15000 ? numeric / 1000 : numeric;
      // ESPN event clock values are elapsed seconds. Convert to match-minute labels.
      return seconds > 0 ? Math.ceil(seconds / 60) : 0;
    }
    return undefined;
  }

  private toDate(value: unknown): Date | undefined {
    if (!value) return undefined;
    if (
      !(value instanceof Date) &&
      typeof value !== 'string' &&
      typeof value !== 'number'
    ) {
      return undefined;
    }
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
}
