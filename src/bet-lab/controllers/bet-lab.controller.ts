import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { EmailVerifiedGuard } from '../../common/guards/email-verified.guard';
import { BetLabFixtureQueryDto } from '../dto/bet-lab-fixture-query.dto';
import { BetLabHistoryQueryDto } from '../dto/bet-lab-history-query.dto';
import { PlaceBetLabSlipDto } from '../dto/place-bet-lab-slip.dto';
import { PlaceBetLabTicketDto } from '../dto/place-bet-lab-ticket.dto';
import { BetLabMarketService } from '../services/bet-lab-market.service';
import { BetLabSlipService } from '../services/bet-lab-slip.service';
import { BetLabStatisticsService } from '../services/bet-lab-statistics.service';
import { BetLabTicketService } from '../services/bet-lab-ticket.service';
import { authenticatedUserId } from '../utils/auth-user.util';

@Controller('bet-lab')
@UseGuards(JwtAuthGuard)
export class BetLabController {
  constructor(
    private readonly marketService: BetLabMarketService,
    private readonly ticketService: BetLabTicketService,
    private readonly slipService: BetLabSlipService,
    private readonly statisticsService: BetLabStatisticsService,
  ) {}

  @Get('catalog')
  getMarketCatalog() {
    return this.marketService.getMarketCatalog();
  }

  @Get('fixtures')
  getFixtures(@Query() query: BetLabFixtureQueryDto) {
    return this.marketService.listFixtures(query);
  }

  @Get('fixtures/:eventId/markets')
  getMarkets(@Param('eventId') eventId: string) {
    return this.marketService.getMarketsForFixture(eventId);
  }

  @Get('fixtures/:eventId/odds')
  async getOdds(@Param('eventId') eventId: string) {
    const result = await this.marketService.getMarketsForFixture(eventId);
    return {
      eventId: result.fixture.eventId,
      oddsMode: 'VIRTUAL_GAME',
      oddsCapturedAt: result.oddsCapturedAt,
      oddsFreshUntil: result.oddsFreshUntil,
      markets: result.markets.map((market) => ({
        code: market.code,
        jsonVariable: market.jsonVariable,
        fullName: market.fullName,
        abbreviation: market.abbreviation,
        available: market.available,
        pricingEnabled: market.pricingEnabled,
        availableSelectionCount: market.availableSelectionCount,
        notes: market.notes,
        selections: market.selections.map((selection) => ({
          code: selection.code,
          jsonVariable: selection.jsonVariable,
          fullName: selection.fullName,
          abbreviation: selection.abbreviation,
          available: selection.available,
          decimalOdds: selection.decimalOdds,
          fairOdds: selection.fairOdds,
          fairOddsBasis: selection.fairOddsBasis,
          marketFairOdds: selection.marketFairOdds,
          impliedProbability: selection.impliedProbability,
          fairProbability: selection.fairProbability,
          valuePercent: selection.valuePercent,
          dataQuality: selection.dataQuality,
          sampleSize: selection.sampleSize,
          calculationVersion: selection.calculationVersion,
          sourceRevision: selection.sourceRevision,
          sourceDataUpdatedAt: selection.sourceDataUpdatedAt,
          provider: selection.provider,
          oddsFreshUntil: selection.oddsFreshUntil,
          isFresh: selection.isFresh,
          /** Odds price the user sees belongs to the virtual Bet Lab game. */
          oddsMode: 'VIRTUAL_GAME' as const,
          oddsSource: selection.oddsSource,
          priceType: selection.priceType,
          bookmaker: selection.bookmaker,
          providerUpdatedAt: selection.providerUpdatedAt,
          oddsTimestampBasis: selection.oddsTimestampBasis,
          oddsCapturedAt: selection.oddsCapturedAt,
          isStale: selection.isStale,
          unavailableReason: selection.unavailableReason,
        })),
      })),
    };
  }

  @UseGuards(EmailVerifiedGuard)
  @Post('tickets')
  placeSingleTicket(
    @GetUser() user: unknown,
    @Body() dto: PlaceBetLabTicketDto,
  ) {
    return this.ticketService.placeSingle(authenticatedUserId(user), dto);
  }

  @UseGuards(EmailVerifiedGuard)
  @Post('slips')
  placeAccumulator(@GetUser() user: unknown, @Body() dto: PlaceBetLabSlipDto) {
    return this.slipService.place(authenticatedUserId(user), dto);
  }

  @Get('tickets')
  getTickets(@GetUser() user: unknown, @Query() query: BetLabHistoryQueryDto) {
    return this.ticketService.listTickets(authenticatedUserId(user), query);
  }

  @Get('tickets/:ticketId')
  getTicket(@GetUser() user: unknown, @Param('ticketId') ticketId: string) {
    return this.ticketService.getTicket(authenticatedUserId(user), ticketId);
  }

  @Get('statistics')
  getStatistics(@GetUser() user: unknown) {
    return this.statisticsService.getUserStatistics(authenticatedUserId(user));
  }
}

