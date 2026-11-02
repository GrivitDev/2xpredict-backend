import { Module } from '@nestjs/common';
import { RolesGuard } from '../common/guards/roles.guard';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt-auth.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { MongooseModule } from '@nestjs/mongoose';
import { WebsiteAnalyticsController } from './website-analytics.controller';
import { WebsiteAnalyticsService } from './website-analytics.service';
import { WebsiteAnalyticsSessionService } from './website-analytics-session.service';
import { WebsiteAnalyticsAggregationService } from './website-analytics-aggregation.service';
import { AnalyticsVisitor, AnalyticsVisitorSchema } from './schemas/analytics-visitor.schema';
import { AnalyticsDailyAggregate, AnalyticsDailyAggregateSchema } from './schemas/analytics-daily.schema';

import { adminRealtimeRegistrationProvider } from '../realtime/admin-realtime-registration.provider';
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AnalyticsVisitor.name, schema: AnalyticsVisitorSchema },
      { name: AnalyticsDailyAggregate.name, schema: AnalyticsDailyAggregateSchema },
    ]),
  ],
  controllers: [WebsiteAnalyticsController],
  providers: [
    adminRealtimeRegistrationProvider('website-analytics', 'Website Analytics: visitor summaries, event ingestion and daily aggregates.'),
    WebsiteAnalyticsService,
    WebsiteAnalyticsSessionService,
    WebsiteAnalyticsAggregationService,
    JwtAuthGuard,
    OptionalJwtAuthGuard,
    RolesGuard,
  ],
  exports: [WebsiteAnalyticsService, WebsiteAnalyticsSessionService, WebsiteAnalyticsAggregationService],
})
export class WebsiteAnalyticsModule {}


