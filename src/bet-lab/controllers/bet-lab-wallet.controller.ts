import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { BetLabLedgerQueryDto } from '../dto/bet-lab-history-query.dto';
import { BetLabWalletHistoryService } from '../services/bet-lab-wallet-history.service';
import { BetLabWalletService } from '../services/bet-lab-wallet.service';
import { authenticatedUserId } from '../utils/auth-user.util';

@Controller('bet-lab/wallet')
@UseGuards(JwtAuthGuard)
export class BetLabWalletController {
  constructor(
    private readonly walletService: BetLabWalletService,
    private readonly historyService: BetLabWalletHistoryService,
  ) {}

  @Get()
  getWallet(@GetUser() user: unknown) {
    return this.walletService.getWallet(authenticatedUserId(user));
  }

  @Get('ledger')
  getLedger(@GetUser() user: unknown, @Query() query: BetLabLedgerQueryDto) {
    return this.historyService.list(
      authenticatedUserId(user),
      query.page,
      query.limit,
    );
  }
}
