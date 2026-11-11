import { forwardRef, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { SettlementModule } from '../settlement/settlement.module';

import { SportsDomainReadController } from './controllers/sports-domain-read.controller';
import { SportsDerivedReadController } from './controllers/sports-derived-read.controller';
import { SportsNewsController } from './controllers/sports-news.controller';
import { SportsMonitorController } from './controllers/sports-monitor.controller';
import { EspnV2Client } from './providers/espn-v2.client';
import { EspnV2Normalizer } from './providers/espn-v2.normalizer';
import { OddsApiClient } from './providers/odds-api.client';
import { YoutubeService } from './providers/youtube.service';
import {
  SportsCompetition,
  SportsCompetitionSchema,
  SportsFixture,
  SportsFixtureSchema,
  SportsMatchOddsSnapshot,
  SportsMatchOddsSnapshotSchema,
  SportsMatchSummary,
  SportsMatchSummarySchema,
  SportsMatchFacts,
  SportsMatchFactsSchema,
  SportsMatchTimelineEvent,
  SportsMatchTimelineEventSchema,
  SportsQueue,
  SportsQueueSchema,
  SportsSeason,
  SportsSeasonSchema,
  SportsTeam,
  SportsTeamSchema,
  SportsNewsArticle,
  SportsNewsArticleSchema,
  SportsCalculatedStandings,
  SportsCalculatedStandingsSchema,
  SportsTeamForm,
  SportsTeamFormSchema,
  SportsTeamHomeAwayRecord,
  SportsTeamHomeAwayRecordSchema,
  SportsTeamScoringRecord,
  SportsTeamScoringRecordSchema,
  SportsHeadToHead,
  SportsHeadToHeadSchema,
  SportsCompetitionScoringTotals,
  SportsCompetitionScoringTotalsSchema,
  SportsTeamStatisticsAggregate,
  SportsTeamStatisticsAggregateSchema,
  SportsPlayerEventTotals,
  SportsPlayerEventTotalsSchema,
} from './schemas';
import { SportsBootstrapState, SportsBootstrapStateSchema } from './schemas/operations/sports-bootstrap-state.schema';
import { SportsCollectionState, SportsCollectionStateSchema } from './schemas/operations/sports-collection-state.schema';
import { SportsDataChangeEvent, SportsDataChangeEventSchema } from './schemas/operations/sports-data-change-event.schema';
import { SportsEntityRevision, SportsEntityRevisionSchema } from './schemas/operations/sports-entity-revision.schema';
import { SportsCollectionStateService } from './services/sports-collection-state.service';
import { SportsDataChangeEventService } from './services/sports-data-change-event.service';
import { SportsDataChangeEventProcessorService } from './services/sports-data-change-event-processor.service';
import { SportsDataChangeEventWorkerService } from './services/sports-data-change-event-worker.service';
import { SportsDomainCollectionService } from './services/sports-domain-collection.service';
import { SportsMatchFactsNormalizationService } from './services/sports-match-facts-normalization.service';
import { SportsDomainReadService } from './services/sports-domain-read.service';
import { SportsReadinessService } from './services/sports-readiness.service';
import { SportsDerivedProjectionService } from './services/sports-derived-projection.service';
import { SportsNewsCollectionService } from './services/sports-news-collection.service';
import { SportsPersistenceService } from './services/sports-persistence.service';
import { SportsProviderCollectionService } from './services/sports-provider-collection.service';
import { SportsQueueBootstrapService } from './services/sports-queue-bootstrap.service';
import { SportsQueueJobProcessorService } from './services/sports-queue-job-processor.service';
import { SportsQueueService } from './services/sports-queue.service';
import { SportsQueueWorkerService } from './services/sports-queue-worker.service';
import { SportsMonitorService } from './services/sports-monitor.service';
import { SportsOddsCollectionService } from './services/sports-odds-collection.service';
import { SportsYoutubeHighlightCollectionService } from './services/sports-youtube-highlight-collection.service';
import { SportsProviderRateLimitService } from './services/sports-provider-rate-limit.service';
import {
  SportsYoutubeHighlight,
  SportsYoutubeHighlightSchema,
} from './schemas/domain/youtube-highlight.schema';
import {
  SportsProviderRateLimit,
  SportsProviderRateLimitSchema,
} from './schemas/sports-provider-rate-limit.schema';

/** Normalized Sports providers, queue orchestration, derived projections and read APIs. */
@Module({
  imports: [
    forwardRef(() => SettlementModule),
    MongooseModule.forFeature([
      { name: SportsCompetition.name, schema: SportsCompetitionSchema },
      { name: SportsSeason.name, schema: SportsSeasonSchema },
      { name: SportsTeam.name, schema: SportsTeamSchema },
      { name: SportsFixture.name, schema: SportsFixtureSchema },
      { name: SportsMatchTimelineEvent.name, schema: SportsMatchTimelineEventSchema },
      { name: SportsMatchOddsSnapshot.name, schema: SportsMatchOddsSnapshotSchema },
      { name: SportsMatchSummary.name, schema: SportsMatchSummarySchema },
      { name: SportsMatchFacts.name, schema: SportsMatchFactsSchema },
      { name: SportsCollectionState.name, schema: SportsCollectionStateSchema },
      { name: SportsDataChangeEvent.name, schema: SportsDataChangeEventSchema },
      { name: SportsEntityRevision.name, schema: SportsEntityRevisionSchema },
      { name: SportsBootstrapState.name, schema: SportsBootstrapStateSchema },
      { name: SportsQueue.name, schema: SportsQueueSchema },
      { name: SportsYoutubeHighlight.name, schema: SportsYoutubeHighlightSchema },
      { name: SportsProviderRateLimit.name, schema: SportsProviderRateLimitSchema },
      { name: SportsNewsArticle.name, schema: SportsNewsArticleSchema },
      { name: SportsCalculatedStandings.name, schema: SportsCalculatedStandingsSchema },
      { name: SportsTeamForm.name, schema: SportsTeamFormSchema },
      { name: SportsTeamHomeAwayRecord.name, schema: SportsTeamHomeAwayRecordSchema },
      { name: SportsTeamScoringRecord.name, schema: SportsTeamScoringRecordSchema },
      { name: SportsHeadToHead.name, schema: SportsHeadToHeadSchema },
      { name: SportsCompetitionScoringTotals.name, schema: SportsCompetitionScoringTotalsSchema },
      { name: SportsTeamStatisticsAggregate.name, schema: SportsTeamStatisticsAggregateSchema },
      { name: SportsPlayerEventTotals.name, schema: SportsPlayerEventTotalsSchema },
    ]),
  ],
  controllers: [SportsDomainReadController, SportsDerivedReadController, SportsNewsController, SportsMonitorController],
  providers: [
    EspnV2Client,
    EspnV2Normalizer,
    OddsApiClient,
    YoutubeService,
    SportsProviderRateLimitService,
    SportsOddsCollectionService,
    SportsYoutubeHighlightCollectionService,
    SportsProviderCollectionService,
    SportsPersistenceService,
    SportsCollectionStateService,
    SportsDataChangeEventService,
    SportsDataChangeEventProcessorService,
    SportsDataChangeEventWorkerService,
    SportsDomainCollectionService,
    SportsMatchFactsNormalizationService,
    SportsQueueService,
    SportsDerivedProjectionService,
    SportsNewsCollectionService,
    SportsQueueJobProcessorService,
    SportsQueueBootstrapService,
    SportsQueueWorkerService,
    SportsMonitorService,
    SportsDomainReadService,
    SportsReadinessService,
  ],
  exports: [
    SportsDomainReadService,
    SportsReadinessService,
    SportsDomainCollectionService,
    SportsMatchFactsNormalizationService,
    SportsDerivedProjectionService,
    SportsNewsCollectionService,
    SportsMonitorService,
    SportsQueueService,
    SportsDataChangeEventService,
  ],
})
export class SportsDataModule {}

