import { ConflictException } from '@nestjs/common';
import type { SportsFixtureContextReadModel } from '../../sports/interfaces/sports-read.interface';
import type { BetLabFixtureIdentity } from '../interfaces/bet-lab-market.interface';

const LIVE_STATES = new Set(['LIVE', 'HALFTIME', 'EXTRA_TIME', 'PENALTIES']);

const LIVE_STATUS_PATTERNS = [
  /\bLIVE\b/,
  /\bHALFTIME\b/,
  /\bHALF[_\s-]?TIME\b/,
  /\bEXTRATIME\b/,
  /\bEXTRA[_\s-]?TIME\b/,
  /\bPENALT(?:Y|IES)\b/,
  /\bIN[_\s-]?PLAY\b/,
  /\bIN[_\s-]?PROGRESS\b/,
  /\bPLAYING\b/,
  /\b(?:FIRST|SECOND)[_\s-]?HALF\b/,
  /\b[12](?:ST|ND)[_\s-]?HALF\b/,
  /\b(?:FIRST|SECOND)[_\s-]?PERIOD\b/,
];
const COMPLETED_STATUS_PATTERN = /COMPLETED|FINISHED|FULL[_ -]?TIME|\bFT\b|\bAET\b|\bPEN\b|FINAL/;
const UNAVAILABLE_STATUS_PATTERN = /POSTPON|CANCEL|ABANDON|SUSPEND|INTERRUPT|DELAY|VOID|NO[_ -]?CONTEST/;

/**
 * Bet Lab is a pre-match virtual-points product. Keep the eligibility rule in
 * one place so fixture browsing, quote resolution and final ticket validation
 * apply exactly the same Sports-state and kickoff checks.
 */
export function assertBetLabPreMatchFixture(
  fixture: BetLabFixtureIdentity,
  now: Date = new Date(),
): void {
  const statusParts = [
    fixture.status,
    fixture.statusDetail,
    fixture.statusShortDetail,
  ].filter(
    (value): value is string =>
      typeof value === 'string' && value.trim().length > 0,
  );
  const combinedStatus = statusParts
    .join(' ')
    .toUpperCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const canonicalState = String(fixture.status ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');

  if (fixture.completed || COMPLETED_STATUS_PATTERN.test(combinedStatus)) {
    throw new ConflictException('This match has already been completed.');
  }

  if (fixture.live || LIVE_STATUS_PATTERNS.some((pattern) => pattern.test(combinedStatus))) {
    throw new ConflictException(
      'Bet Lab accepts pre-match fixtures only. Live or in-play matches cannot be selected.',
    );
  }

  if (UNAVAILABLE_STATUS_PATTERN.test(combinedStatus)) {
    throw new ConflictException('This match is not available for Bet Lab tickets.');
  }

  // Do not treat UNKNOWN or an unrecognized provider state as pre-match. The
  // normalized Sports state must explicitly confirm that the fixture is scheduled.
  if (canonicalState !== 'SCHEDULED') {
    throw new ConflictException('Bet Lab tickets are available only for scheduled fixtures.');
  }

  const kickoffAt = new Date(fixture.fixtureDate).getTime();
  if (!Number.isFinite(kickoffAt) || kickoffAt <= now.getTime()) {
    throw new ConflictException('Ticket placement is closed for this fixture.');
  }
}

/** Maps canonical Sports records into the stable Bet Lab fixture contract. */
export function toBetLabFixtureIdentity(
  context: SportsFixtureContextReadModel,
): BetLabFixtureIdentity {
  const { fixture, competition, homeTeam, awayTeam } = context;
  const home = fixture.competitors.find((item) => item.homeAway === 'HOME');
  const away = fixture.competitors.find((item) => item.homeAway === 'AWAY');
  const state = fixture.status.state;
  const sourceCollectedAt = new Date(fixture.source.collectedAt.getTime());
  const sportsUpdatedAt = new Date(fixture.updatedAt.getTime());

  const venueName =
    'venue' in context &&
    typeof context.venue === 'object' &&
    context.venue !== null &&
    'name' in context.venue &&
    typeof context.venue.name === 'string'
      ? context.venue.name
      : undefined;

  return {
    eventId: fixture.id,
    leagueId: fixture.competitionId,
    leagueName:
      competition?.displayName || competition?.name || fixture.competitionId,
    fixtureDate: new Date(fixture.kickoffAt.getTime()),
    live: LIVE_STATES.has(state),
    completed: state === 'COMPLETED' || fixture.status.isFinal === true,
    homeTeamId: home?.teamId ?? '',
    homeTeamName:
      homeTeam?.displayName || homeTeam?.name || home?.teamId || 'Home Team',
    awayTeamId: away?.teamId ?? '',
    awayTeamName:
      awayTeam?.displayName || awayTeam?.name || away?.teamId || 'Away Team',
    venueName,
    status: state,
    statusDetail:
      fixture.status.description || fixture.status.providerState || undefined,
    statusShortDetail:
      fixture.status.shortDescription || fixture.status.name || undefined,
    collectedAt: sourceCollectedAt,
    sportsUpdatedAt,
    // Bet Lab no longer depends on ESPN summary payloads. Keep an empty object
    // for consumers that still expect a payload-shaped fixture property.
    payload: {},
  };
}

export function isBetLabFixtureContextComplete(
  context: SportsFixtureContextReadModel,
): boolean {
  const home = context.fixture.competitors.find(
    (item) => item.homeAway === 'HOME',
  );
  const away = context.fixture.competitors.find(
    (item) => item.homeAway === 'AWAY',
  );
  return Boolean(
    context.competition &&
    home &&
    away &&
    context.homeTeam &&
    context.awayTeam &&
    context.fixture.id &&
    context.fixture.competitionId,
  );
}
