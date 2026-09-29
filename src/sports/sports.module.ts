import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { SportsController } from './sports.controller';

import { SportsService } from './sports.service';

import { EspnService } from './providers/espn.service';
import { FootballDataService } from './providers/football-data.service';
import { TheOddsApiService } from './providers/the-odds-api.service';
import { YoutubeService } from './providers/youtube.service';

import { SportsProviderRateLimitService } from './services/sports-provider-rate-limit.service';

import { PriorityCompetitionService } from './services/priority-competition.service';
import { ActiveCompetitionService } from './services/active-competition.service';
import { EspnActiveCompetitionService } from './services/espn-active-competition.service';

import { EspnQueueService } from './services/espn-queue.service';
import { EspnQueueBuilderService } from './services/espn-queue-builder.service';
import { EspnQueueWorkerService } from './services/espn-queue-worker.service';
import { SportsSyncStateService } from './services/sports-sync-state.service';

import { SportsCollectionService } from './services/sports-collection.service';
import { SportsDataReadService } from './services/sports-data-read.service';
import { SportsSystemMonitorService } from './services/sports-system-monitor.service';

import { SportsStartupService } from './services/sports-startup.service';

import { YoutubeHighlightService } from './services/youtube-highlight.service';

import { FootballDataScheduler } from './schedulers/football-data.scheduler';
import { NewsScheduler } from './schedulers/news.scheduler';

import {
  ActiveCompetition,
  ActiveCompetitionSchema,
} from './schemas/active-competition.schema';

import {
  EspnLeague,
  EspnLeagueSchema,
} from './schemas/espn/espn-league.schema';

import {
  EspnFixture,
  EspnFixtureSchema,
} from './schemas/espn/espn-fixture.schema';

import { EspnNews, EspnNewsSchema } from './schemas/espn/espn-news.schema';

import {
  EspnStanding,
  EspnStandingSchema,
} from './schemas/espn/espn-standing.schema';

import { EspnTeam, EspnTeamSchema } from './schemas/espn/espn-team.schema';

import { EspnQueue, EspnQueueSchema } from './schemas/espn-queue.schema';

import {
  SportsSyncState,
  SportsSyncStateSchema,
} from './schemas/sports-sync-state.schema';

import {
  FootballDataCompetition,
  FootballDataCompetitionSchema,
} from './schemas/football-data/football-data-competition.schema';

import {
  FootballDataMatch,
  FootballDataMatchSchema,
} from './schemas/football-data/football-data-match.schema';

import {
  FootballDataStanding,
  FootballDataStandingSchema,
} from './schemas/football-data/football-data-standing.schema';

import {
  FootballDataTeam,
  FootballDataTeamSchema,
} from './schemas/football-data/football-data-team.schema';

import {
  OddsApiSport,
  OddsApiSportSchema,
} from './schemas/odds-api-sport.schema';

import {
  SportsOddsSnapshot,
  SportsOddsSnapshotSchema,
} from './schemas/sports-odds-snapshot.schema';

import {
  SportsProviderRateLimit,
  SportsProviderRateLimitSchema,
} from './schemas/sports-provider-rate-limit.schema';

import {
  YouTubeHighlight,
  YouTubeHighlightSchema,
} from './schemas/youtube-highlight.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: ActiveCompetition.name,
        schema: ActiveCompetitionSchema,
      },

      {
        name: EspnLeague.name,
        schema: EspnLeagueSchema,
      },

      {
        name: EspnFixture.name,
        schema: EspnFixtureSchema,
      },

      /*
       * ESPN News remains registered as fallback/manual provider data.
       * It is no longer part of the normal collection queue.
       */
      {
        name: EspnNews.name,
        schema: EspnNewsSchema,
      },

      /*
       * ESPN Standings remains registered as fallback/manual provider data.
       * Normal startup/live processing uses ESPN Summary instead.
       */
      {
        name: EspnStanding.name,
        schema: EspnStandingSchema,
      },

      {
        name: EspnTeam.name,
        schema: EspnTeamSchema,
      },

      /*
       * Queue now contains only:
       * - FIXTURE_REFRESH
       * - SUMMARY_REFRESH
       */
      {
        name: EspnQueue.name,
        schema: EspnQueueSchema,
      },

      {
        name: SportsSyncState.name,
        schema: SportsSyncStateSchema,
      },

      {
        name: FootballDataCompetition.name,
        schema: FootballDataCompetitionSchema,
      },

      {
        name: FootballDataMatch.name,
        schema: FootballDataMatchSchema,
      },

      {
        name: FootballDataStanding.name,
        schema: FootballDataStandingSchema,
      },

      {
        name: FootballDataTeam.name,
        schema: FootballDataTeamSchema,
      },

      {
        name: OddsApiSport.name,
        schema: OddsApiSportSchema,
      },

      {
        name: SportsOddsSnapshot.name,
        schema: SportsOddsSnapshotSchema,
      },

      {
        name: SportsProviderRateLimit.name,
        schema: SportsProviderRateLimitSchema,
      },

      {
        name: YouTubeHighlight.name,
        schema: YouTubeHighlightSchema,
      },
    ]),
  ],

  controllers: [SportsController],

  providers: [
    SportsService,

    // ESPN
    EspnService,
    EspnActiveCompetitionService,

    // Other independent providers
    FootballDataService,
    TheOddsApiService,
    YoutubeService,

    // Global provider rate limiting
    SportsProviderRateLimitService,

    // Competition registry
    PriorityCompetitionService,
    ActiveCompetitionService,

    // ESPN queue
    EspnQueueService,
    EspnQueueBuilderService,
    EspnQueueWorkerService,
    SportsSyncStateService,

    // Collection / read
    SportsCollectionService,
    SportsDataReadService,
    SportsSystemMonitorService,

    // YouTube lifecycle
    YoutubeHighlightService,

    // Startup
    SportsStartupService,

    // Remaining scheduled providers
    FootballDataScheduler,
    NewsScheduler,
  ],

  exports: [
    SportsService,
    SportsDataReadService,
    SportsSystemMonitorService,
    ActiveCompetitionService,
    EspnService,
    SportsSyncStateService,
  ],
})
export class SportsModule {}
