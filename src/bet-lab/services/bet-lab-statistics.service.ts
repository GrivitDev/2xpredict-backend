import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BetLabTicketStatus } from '../enums/bet-lab-ticket-status.enum';
import { BetLabTicket } from '../schemas/bet-lab-ticket.schema';
import { BetLabWalletService } from './bet-lab-wallet.service';

@Injectable()
export class BetLabStatisticsService {
  constructor(
    @InjectModel(BetLabTicket.name)
    private readonly ticketModel: Model<BetLabTicket>,
    private readonly walletService: BetLabWalletService,
  ) {}

  async getUserStatistics(userId: string) {
    const [wallet, openTickets, pendingTickets, recentlySettled] =
      await Promise.all([
        this.walletService.getWallet(userId),
        this.ticketModel
          .countDocuments({ userId, status: BetLabTicketStatus.OPEN })
          .exec(),
        this.ticketModel
          .countDocuments({
            userId,
            status: BetLabTicketStatus.PENDING_SETTLEMENT,
          })
          .exec(),
        this.ticketModel
          .countDocuments({
            userId,
            status: {
              $in: [
                BetLabTicketStatus.WON,
                BetLabTicketStatus.LOST,
                BetLabTicketStatus.VOID,
                BetLabTicketStatus.PUSH,
                BetLabTicketStatus.PARTIALLY_WON,
                BetLabTicketStatus.PARTIALLY_LOST,
              ],
            },
            visibleUntil: { $gt: new Date() },
          })
          .exec(),
      ]);
    const settledCount = wallet.ticketsSettled;
    const decisiveSettledCount = wallet.ticketsWon + wallet.ticketsLost;
    return {
      wallet: {
        balance: wallet.balance,
        welcomeBalance: wallet.welcomeBalance,
        monthlyBalance: wallet.monthlyBalance,
        winningsBalance: wallet.winningsBalance,
        bonusBalance: wallet.bonusBalance,
        monthlyAllowanceAmount: wallet.monthlyAllowanceAmount,
        monthlyAllowancePlan: wallet.monthlyAllowancePlan,
        monthlyPeriodStart: wallet.monthlyPeriodStart,
        monthlyPeriodEnd: wallet.monthlyPeriodEnd,
      },
      performance: {
        ticketsPlaced: wallet.ticketsPlaced,
        ticketsSettled: settledCount,
        ticketsWon: wallet.ticketsWon,
        ticketsLost: wallet.ticketsLost,
        ticketsVoided: wallet.ticketsVoided,
        ticketsPushed: wallet.ticketsPushed,
        ticketsPartiallyWon: wallet.ticketsPartiallyWon,
        ticketsPartiallyLost: wallet.ticketsPartiallyLost,
        totalStaked: wallet.totalStaked,
        totalReturns: wallet.totalReturns,
        netProfitLoss: wallet.netProfitLoss,
        /** Excludes voids, pushes and partial outcomes from the decisive win-rate denominator. */
        winRatePercent:
          decisiveSettledCount > 0
            ? Number(
                ((wallet.ticketsWon / decisiveSettledCount) * 100).toFixed(2),
              )
            : 0,
      },
      ticketStatus: {
        open: openTickets,
        pendingSettlement: pendingTickets,
        recentlySettledVisible: recentlySettled,
      },
    };
  }
}

