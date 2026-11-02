import { forwardRef, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { EmailVerifiedGuard } from '../common/guards/email-verified.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { OddsModule } from '../odds/odds.module';
import {
  EspnFixture,
  EspnFixtureSchema,
} from '../sports/schemas/espn/espn-fixture.schema';
import {
  EspnLeague,
  EspnLeagueSchema,
} from '../sports/schemas/espn/espn-league.schema';
import { BetLabAdminController } from './controllers/bet-lab-admin.controller';
import { BetLabController } from './controllers/bet-lab.controller';
import { BetLabWalletController } from './controllers/bet-lab-wallet.controller';
import { BetLabEvent, BetLabEventSchema } from './schemas/bet-lab-event.schema';
import {
  BetLabSettings,
  BetLabSettingsSchema,
} from './schemas/bet-lab-settings.schema';
import {
  BetLabTicket,
  BetLabTicketSchema,
} from './schemas/bet-lab-ticket.schema';
import {
  BetLabWallet,
  BetLabWalletSchema,
} from './schemas/bet-lab-wallet.schema';
import {
  BetLabWalletLedger,
  BetLabWalletLedgerSchema,
} from './schemas/bet-lab-wallet-ledger.schema';
import { BetLabEventService } from './services/bet-lab-event.service';
import { BetLabSettingsService } from './services/bet-lab-settings.service';
import { BetLabMarketService } from './services/bet-lab-market.service';
import { BetLabMonitorService } from './services/bet-lab-monitor.service';
import { BetLabRetentionService } from './services/bet-lab-retention.service';
import { BetLabSettlementAdapterService } from './services/bet-lab-settlement-adapter.service';
import { BetLabSlipService } from './services/bet-lab-slip.service';
import { BetLabStatisticsService } from './services/bet-lab-statistics.service';
import { BetLabTicketService } from './services/bet-lab-ticket.service';
import { BetLabWalletHistoryService } from './services/bet-lab-wallet-history.service';
import { BetLabWalletService } from './services/bet-lab-wallet.service';

import { adminRealtimeRegistrationProvider } from '../realtime/admin-realtime-registration.provider';
import { SettlementModule } from '../settlement/settlement.module';
@Module({
  imports: [
    SubscriptionsModule,
    OddsModule,
    forwardRef(() => SettlementModule),
    MongooseModule.forFeature([
      { name: EspnFixture.name, schema: EspnFixtureSchema },
      { name: EspnLeague.name, schema: EspnLeagueSchema },
      { name: BetLabWallet.name, schema: BetLabWalletSchema },
      { name: BetLabWalletLedger.name, schema: BetLabWalletLedgerSchema },
      { name: BetLabTicket.name, schema: BetLabTicketSchema },
      { name: BetLabEvent.name, schema: BetLabEventSchema },
      { name: BetLabSettings.name, schema: BetLabSettingsSchema },
    ]),
  ],
  controllers: [
    BetLabController,
    BetLabWalletController,
    BetLabAdminController,
  ],
  providers: [
    adminRealtimeRegistrationProvider('bet-lab', 'Bet Lab: tickets, wallets, ledger, market readiness and virtual settlement.'),
    JwtAuthGuard,
    EmailVerifiedGuard,
    RolesGuard,
    BetLabEventService,
    BetLabSettingsService,
    BetLabMarketService,
    BetLabWalletService,
    BetLabWalletHistoryService,
    BetLabTicketService,
    BetLabSlipService,
    BetLabStatisticsService,
    BetLabSettlementAdapterService,
    BetLabMonitorService,
    BetLabRetentionService,
  ],
  exports: [
    BetLabSettlementAdapterService,
    BetLabWalletService,
    BetLabWalletHistoryService,
    BetLabTicketService,
    BetLabMonitorService,
  ],
})
export class BetLabModule {}
