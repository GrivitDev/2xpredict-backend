import { forwardRef, Module } from '@nestjs/common';
import { RolesGuard } from '../common/guards/roles.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { MongooseModule } from '@nestjs/mongoose';
import { SettlementModule } from '../settlement/settlement.module';

import { SportsController } from './sports.controller';

import { SportsService } from './sports.service';

import { EspnService } from './providers/espn.service';
import { FootballDataService } from './providers/football-data.service';
import { YoutubeService } from './providers/youtube.service';

import { SportsProviderRateLimitService } from './services/sports-provider-rate-limit.service';

import { PriorityCompetitionService } from './services/priority-competition.service';
import { ActiveCompetitionService } from './services/active-competition.service';
import { EspnActiveCompetitionService } from './services/espn-active-competition.service';

import { EspnQueueService } from './services/espn-queue.service';
import { EspnQueueBuilderService } from './services/espn-queue-builder.service';
import { EspnQueueWorkerService } from './services/espn-queue-worker.service';
import { EspnSeasonDataService } from './services/espn-season-data.service';
import { SportsSyncStateService } from './services/sports-sync-state.service';
import { EspnStandingsService } from './services/espn-standings.service';

import { SportsCollectionService } from './services/sports-collection.service';
import { SportsDataReadService } from './services/sports-data-read.service';
import { SportsSystemMonitorService } from './services/sports-system-monitor.service';

import { SportsStartupService } from './services/sports-startup.service';

import { YoutubeHighlightService } from './services/youtube-highlight.service';

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

import {
  EspnStandingsCollectionState,
  EspnStandingsCollectionStateSchema,
} from './schemas/espn/espn-standings-collection-state.schema';

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

import { adminRealtimeRegistrationProvider } from '../realtime/admin-realtime-registration.provider';
@Module({
  imports: [
    forwardRef(() => SettlementModule),
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
        name: EspnStandingsCollectionState.name,
        schema: EspnStandingsCollectionStateSchema,
      },

      {
        name: EspnTeam.name,
        schema: EspnTeamSchema,
      },

      /*
       * Normal queue work is limited to fixture refreshes, Summary refreshes,
       * and YouTube highlights. News is extracted from saved Summaries.
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
    adminRealtimeRegistrationProvider('sports', 'Sports: fixture collection, queues, sync state, standings, highlights and provider monitoring.'),
    SportsService,
    // ESPN
    EspnService,
    EspnActiveCompetitionService,
    // Other independent providers
    FootballDataService,
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
    EspnSeasonDataService,
    SportsSyncStateService,
    EspnStandingsService,
    // Collection / read
    SportsCollectionService,
    SportsDataReadService,
    SportsSystemMonitorService,
    // YouTube lifecycle
    YoutubeHighlightService,
    // Startup
    SportsStartupService,
    // Recurring sports work is persisted in the ESPN queue; no sports cron providers are registered.,
    JwtAuthGuard,
    RolesGuard,
  ],

  exports: [
    SportsService,
    SportsDataReadService,
    SportsSystemMonitorService,
    ActiveCompetitionService,
    EspnService,
    EspnQueueService,
    SportsCollectionService,
    EspnStandingsService,
    SportsSyncStateService,
  ],
})
export class SportsModule {}


