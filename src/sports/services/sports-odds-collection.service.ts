import { Injectable, Logger } from '@nestjs/common';

import type { MatchOddsCollectionResult } from '../interfaces/provider-response.interface';
import { OddsApiClient } from '../providers/odds-api.client';
import { EspnV2Client } from '../providers/espn-v2.client';
import { EspnV2Normalizer } from '../providers/espn-v2.normalizer';

type OddsContext = Parameters<EspnV2Normalizer['normalizeEspnOdds']>[1];
type OddsApiOptions = NonNullable<Parameters<OddsApiClient['getEventOdds']>[2]>;
type MatchOddsCollectionRequest = {
  fixtureId: OddsContext['fixtureId'];
  homeTeam: OddsContext['homeTeam'];
  awayTeam: OddsContext['awayTeam'];
  kickoffAt: OddsContext['kickoffAt'];
  espnLeagueId: Parameters<EspnV2Client['getMatchOdds']>[0];
  espnEventId: Parameters<EspnV2Client['getMatchOdds']>[1];
  espnCompetitionId?: OddsContext['competitionId'];
  oddsApiSportKey?: Parameters<OddsApiClient['getSportOdds']>[0] | null;
  oddsApiEventId?: Parameters<OddsApiClient['getEventOdds']>[1] | null;
  regions?: OddsApiOptions['regions'];
  markets?: OddsApiOptions['markets'];
};

/**
 * Ordered odds recovery chain:
 * 1) ESPN Core match /odds endpoint.
 * 2) ESPN Site Summary pickcenter payload.
 * 3) The Odds API (only if both ESPN sources have no usable bookmaker prices).
 */
@Injectable()
export class SportsOddsCollectionService {
  private readonly logger = new Logger(SportsOddsCollectionService.name);

  constructor(
    private readonly espn: EspnV2Client,
    private readonly oddsApi: OddsApiClient,
    private readonly normalizer: EspnV2Normalizer,
  ) {}

  async collectFixtureOdds(
    input: MatchOddsCollectionRequest,
  ): Promise<MatchOddsCollectionResult> {
    const context = {
      fixtureId: input.fixtureId,
      homeTeam: input.homeTeam,
      awayTeam: input.awayTeam,
      kickoffAt: input.kickoffAt,
      collectedAt: new Date(),
      leagueId: input.espnLeagueId,
      eventId: input.espnEventId,
      competitionId: input.espnCompetitionId ?? input.espnEventId,
    };
    const failures: string[] = [];
    const providerErrors: unknown[] = [];
    const retryableErrors: unknown[] = [];
    const rememberProviderError = (error: unknown): void => {
      providerErrors.push(error);
      if (error && typeof error === 'object' && 'retryable' in error
        && (error as { retryable?: unknown }).retryable === true) {
        retryableErrors.push(error);
      }
    };

    // 1. ESPN dedicated odds endpoint.
    try {
      const response = await this.espn.getMatchOdds(
        input.espnLeagueId,
        input.espnEventId,
        input.espnCompetitionId ?? input.espnEventId,
      );
      const snapshot = this.normalizer.normalizeEspnOdds(
        response,
        context,
        `/leagues/${input.espnLeagueId}/events/${input.espnEventId}/odds`,
      );
      if (snapshot) return { snapshot, provider: 'ESPN', fallbackUsed: false };
      failures.push('ESPN /odds returned no usable bookmaker markets/prices');
    } catch (error) {
      rememberProviderError(error);
      failures.push(`ESPN /odds failed: ${this.errorMessage(error)}`);
      this.logger.warn(
        `ESPN /odds unavailable for ${input.fixtureId}; trying Summary pickcenter.`,
      );
    }

    // 2. ESPN Summary pickcenter. This is still ESPN data, not a second provider.
    try {
      const summary = await this.espn.getMatchSummary(
        input.espnLeagueId,
        input.espnEventId,
      );
      const snapshot = this.normalizer.normalizeEspnSummaryOdds(
        summary,
        context,
        `/leagues/${input.espnLeagueId}/events/${input.espnEventId}/summary`,
      );
      if (snapshot) {
        return {
          snapshot,
          provider: 'ESPN_SUMMARY',
          fallbackUsed: true,
          reason: failures.join('; '),
        };
      }
      failures.push(
        'ESPN Summary pickcenter contained no usable bookmaker markets/prices',
      );
    } catch (error) {
      rememberProviderError(error);
      failures.push(
        `ESPN Summary fallback failed: ${this.errorMessage(error)}`,
      );
      this.logger.warn(
        `ESPN Summary odds unavailable for ${input.fixtureId}; evaluating The Odds API.`,
      );
    }

    // 3. The Odds API is the final provider fallback.
    if (!input.oddsApiSportKey?.trim()) {
      // Empty bookmaker responses are valid no-data outcomes. Actual endpoint
      // exceptions remain failures and retain the provider's retryability.
      if (providerErrors.length) throw retryableErrors[0] ?? providerErrors[0];
      return {
        snapshot: null,
        provider: null,
        fallbackUsed: false,
        reason: `${failures.join('; ')}; no Odds API sport-key mapping exists`,
      };
    }

    if (input.oddsApiEventId?.trim()) {
      try {
        const event = await this.oddsApi.getEventOdds(
          input.oddsApiSportKey,
          input.oddsApiEventId,
          { regions: input.regions, markets: input.markets },
        );
        const snapshot = this.normalizer.normalizeOddsApiEvent(event, context);
        if (snapshot)
          return {
            snapshot,
            provider: 'ODDS_API',
            fallbackUsed: true,
            reason: failures.join('; '),
          };
        failures.push(
          'Odds API event endpoint returned no matching usable prices',
        );
      } catch (error) {
        rememberProviderError(error);
        failures.push(
          `Odds API event lookup failed: ${this.errorMessage(error)}`,
        );
      }
    }

    // A direct event mapping may be absent or stale; the sport listing is a
    // separate final recovery route, matched strictly by team names + kickoff.
    try {
      const collection = await this.oddsApi.getSportOdds(
        input.oddsApiSportKey,
        { regions: input.regions, markets: input.markets },
      );
      for (const event of collection.items) {
        const snapshot = this.normalizer.normalizeOddsApiEvent(event, context);
        if (snapshot)
          return {
            snapshot,
            provider: 'ODDS_API',
            fallbackUsed: true,
            reason: failures.join('; '),
          };
      }
      failures.push(
        'Odds API sport listing contained no exact matching event with usable prices',
      );
    } catch (error) {
      rememberProviderError(error);
      failures.push(
        `Odds API sport listing failed: ${this.errorMessage(error)}`,
      );
    }

    // A final no-data result is only definitive if provider calls themselves
    // completed. Preserve retryability for 429, 5xx, timeout and network errors.
    if (providerErrors.length) throw retryableErrors[0] ?? providerErrors[0];
    return {
      snapshot: null,
      provider: null,
      fallbackUsed: false,
      reason: failures.join('; '),
    };
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error
      ? error.message.replace(/[\r\n]+/g, ' ').slice(0, 220)
      : String(error).slice(0, 220);
  }
}
