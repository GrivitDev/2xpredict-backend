export const SPORTS_DATA_COLLECTION_CONFIG = {
  // ==========================================================
  // ESPN
  // ==========================================================

  ESPN: {
    enabled: true,

    /**
     * ESPN does not have an application-level daily quota
     * in our collection architecture.
     *
     * Endpoint request spacing is enforced by the provider
     * rate-limit service at two seconds.
     *
     * ESPN concurrency is controlled separately by that
     * service:
     *
     *   1 reserved live request
     *   4 normal requests
     *
     * for a maximum of five concurrent ESPN requests.
     */
    rateLimit: {
      minIntervalSeconds: 2,
    },

    /**
     * Complete ESPN soccer league catalogue.
     *
     * The catalogue is refreshed weekly.
     */
    catalogue: {
      refreshIntervalDays: 7,
    },

    /**
     * Active competition matching.
     *
     * The stored ESPN catalogue is checked for competitions
     * that currently have active fixtures.
     */
    activeCompetitions: {
      enabled: true,
      refreshIntervalMinutes: 10,
    },

    /**
     * Fixture collection.
     *
     * Active competitions are processed according to priority.
     *
     * Normal operations keep today's fixtures and the
     * configured upcoming window synchronized.
     *
     * A league is also considered stale when its fixture
     * collection has not been refreshed for 48 hours.
     */
    fixtures: {
      enabled: true,

      /**
       * Number of days ahead included in normal fixture
       * synchronization.
       */
      forwardDays: 8,

      /**
       * Minimum freshness guarantee for active competitions.
       *
       * If a league has not had a fixture refresh for this
       * many hours, a refresh should be scheduled after
       * confirming the competition is still active.
       */
      staleAfterHours: 48,

      /**
       * Queue spacing between normal fixture work slots.
       */
      slotIntervalMinutes: 0.02,
    },

    /**
     * ESPN Summary collection.
     *
     * Summary is the canonical detailed match-data payload
     * stored in:
     *
     *   sports_espn_fixtures.payload.summary
     *
     * Startup hydrates Summary for all persisted fixtures.
     *
     * Normal operations collect Summary for:
     *
     *   1. fixtures within the next four days
     *   2. fixtures that have just completed
     *
     * A Summary job must never be created when the fixture
     * already contains payload.summary.
     */
    summary: {
      enabled: true,

      /**
       * Upcoming Summary collection window.
       */
      upcomingWindowDays: 4,

      /**
       * Finished fixtures receive Summary immediately after
       * completion is detected.
       */
      immediatelyAfterFinished: true,

      /**
       * Startup hydrates Summary for all persisted fixtures.
       */
      startupAllFixtures: true,
    },

    /**
     * Queue safety.
     */
    queue: {
      enabled: true,
      maxAttempts: 3,
      staleProcessingMinutes: 5,
      retryDelayMinutes: 5,
    },
  },

  // ==========================================================
  // FOOTBALL-DATA
  // ==========================================================

  FOOTBALL_DATA: {
    enabled: true,

    rateLimit: {
      minIntervalSeconds: 60,
    },

    live: {
      intervalMinutes: 5,
    },
  },

  // ==========================================================
  // THE ODDS API
  // ==========================================================

  ODDS_API: {
    enabled: true,

    /**
     * Application-level monthly request budget.
     */
    monthlyRequestLimit: 450,

    rateLimit: {
      minIntervalSeconds: 60,
    },

    /**
     * Refresh the provider sport catalogue periodically.
     */
    sportsRefreshDays: 30,

    oddsCollection: {
      daily: true,
      slotIntervalMinutes: 1,
    },
  },

  // ==========================================================
  // YOUTUBE
  // ==========================================================

  YOUTUBE: {
    enabled: true,

    /**
     * Internal daily search safety budget.
     *
     * This remains separate from ESPN.
     */
    dailyRequestLimit: 90,

    rateLimit: {
      minIntervalSeconds: 200,
    },

    queue: {
      enabled: true,
      intervalMinutes: 20,
      maxAttempts: 3,
      retryDelayMinutes: 20,
    },
  },
} as const;

export type SportsDataCollectionConfig = typeof SPORTS_DATA_COLLECTION_CONFIG;
