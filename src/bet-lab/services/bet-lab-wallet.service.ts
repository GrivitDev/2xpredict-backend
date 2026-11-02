import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, HydratedDocument, Model } from 'mongoose';
import { BET_LAB_CONFIG, BetLabPlan } from '../config/bet-lab.config';
import {
  BetLabCreditBucket,
  BetLabLedgerType,
} from '../enums/bet-lab-ledger-type.enum';
import {
  BetLabEventCategory,
  BetLabEventLevel,
} from '../enums/bet-lab-event.enum';
import { BetLabWallet } from '../schemas/bet-lab-wallet.schema';
import { BetLabWalletLedger } from '../schemas/bet-lab-wallet-ledger.schema';
import { SubscriptionsService } from '../../subscriptions/subscriptions.service';
import { BetLabEventService } from './bet-lab-event.service';
import { BetLabSettingsService } from './bet-lab-settings.service';

interface CurrentEntitlement {
  plan: BetLabPlan;
  periodStart?: Date;
  periodEnd?: Date;
}

export interface BetLabWalletSnapshot {
  walletId: string;
  userId: string;
  balance: number;
  welcomeBalance: number;
  monthlyBalance: number;
  winningsBalance: number;
  bonusBalance: number;
  registrationBonusGranted: boolean;
  monthlyAllowanceAmount: number;
  monthlyAllowancePlan: BetLabPlan;
  monthlyPeriodStart: Date;
  monthlyPeriodEnd: Date;
  totalStaked: number;
  totalReturns: number;
  netProfitLoss: number;
  ticketsPlaced: number;
  ticketsSettled: number;
  ticketsWon: number;
  ticketsLost: number;
  ticketsVoided: number;
  ticketsPushed: number;
  ticketsPartiallyWon: number;
  ticketsPartiallyLost: number;
  lastTicketAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

@Injectable()
export class BetLabWalletService {
  private readonly logger = new Logger(BetLabWalletService.name);

  constructor(
    @InjectModel(BetLabWallet.name)
    private readonly walletModel: Model<BetLabWallet>,
    @InjectModel(BetLabWalletLedger.name)
    private readonly ledgerModel: Model<BetLabWalletLedger>,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly events: BetLabEventService,
    private readonly settingsService: BetLabSettingsService,
  ) {}

  // Read-only admin inspection. Unlike getWallet(), this never creates a wallet
  // or grants a first-login/monthly allowance merely because an admin opened a profile.
  async getExistingWalletSnapshot(
    userId: string,
  ): Promise<BetLabWalletSnapshot | null> {
    const wallet = await this.walletModel.findOne({ userId }).lean().exec();
    return wallet ? this.toSnapshot(wallet) : null;
  }

  async getWallet(userId: string): Promise<BetLabWalletSnapshot> {
    const entitlement = await this.getCurrentEntitlement(userId);
    const session = await this.walletModel.db.startSession();
    let snapshot: BetLabWalletSnapshot | null = null;
    try {
      await session.withTransaction(async () => {
        const wallet = await this.ensureWalletInSession(
          userId,
          entitlement,
          session,
        );
        snapshot = this.toSnapshot(wallet);
      });
    } catch (error) {
      if (this.isDuplicateKey(error)) {
        const racedWallet = await this.walletModel.findOne({ userId }).exec();
        if (racedWallet) return this.toSnapshot(racedWallet);
      }
      throw error;
    } finally {
      await session.endSession();
    }
    if (!snapshot)
      throw new InternalServerErrorException(
        'Bet Lab wallet could not be loaded',
      );
    return snapshot;
  }

  /**
   * Internal transaction helper shared by ticket placement and wallet reads.
   * Caller owns the MongoDB session and transaction.
   */
  async ensureWalletInSession(
    userId: string,
    entitlement: CurrentEntitlement,
    session: ClientSession,
  ): Promise<HydratedDocument<BetLabWallet>> {
    const now = new Date();
    const virtualPointsSettings =
      await this.settingsService.getVirtualPointsSettings(session);
    let wallet = await this.walletModel
      .findOne({ userId })
      .session(session)
      .exec();

    if (!wallet) {
      const welcome = virtualPointsSettings.registrationBonus;
      const monthly =
        virtualPointsSettings.monthlyAllowanceByPlan[entitlement.plan];
      const periodStart =
        entitlement.periodStart && entitlement.periodStart <= now
          ? entitlement.periodStart
          : now;
      const periodEnd =
        entitlement.periodEnd && entitlement.periodEnd > now
          ? entitlement.periodEnd
          : this.addDays(now, BET_LAB_CONFIG.virtualPoints.allowancePeriodDays);
      const initialBalance = welcome + monthly;
      const createdWallets = await this.walletModel.create(
        [
          {
            userId,
            balance: initialBalance,
            welcomeBalance: welcome,
            monthlyBalance: monthly,
            winningsBalance: 0,
            bonusBalance: 0,
            registrationBonusGranted: true,
            monthlyAllowanceAmount: monthly,
            monthlyAllowancePlan: entitlement.plan,
            monthlyPeriodStart: periodStart,
            monthlyPeriodEnd: periodEnd,
            totalStaked: 0,
            totalReturns: 0,
            netProfitLoss: 0,
            ticketsPlaced: 0,
            ticketsSettled: 0,
            ticketsWon: 0,
            ticketsLost: 0,
            ticketsVoided: 0,
            ticketsPushed: 0,
            ticketsPartiallyWon: 0,
            ticketsPartiallyLost: 0,
          },
        ],
        { session, ordered: true },
      );
      wallet = createdWallets[0];
      await this.ledgerModel.create(
        [
          {
            userId,
            walletId: String(wallet._id),
            transactionType: BetLabLedgerType.REGISTRATION_BONUS,
            bucket: BetLabCreditBucket.WELCOME,
            delta: welcome,
            amount: welcome,
            balanceBefore: 0,
            balanceAfter: welcome,
            idempotencyKey: `WELCOME:${userId}`,
            description: 'One-time Bet Lab registration bonus',
          },
          {
            userId,
            walletId: String(wallet._id),
            transactionType: BetLabLedgerType.MONTHLY_ALLOWANCE,
            bucket: BetLabCreditBucket.MONTHLY,
            delta: monthly,
            amount: monthly,
            balanceBefore: welcome,
            balanceAfter: initialBalance,
            idempotencyKey: `ALLOWANCE:${userId}:${this.periodKey(periodStart, periodEnd)}`,
            description: `${entitlement.plan} Bet Lab allowance`,
            metadata: { plan: entitlement.plan, periodStart, periodEnd },
          },
        ],
        { session, ordered: true },
      );
      await this.events.record({
        level: BetLabEventLevel.INFO,
        category: BetLabEventCategory.WALLET,
        action: 'WALLET_CREATED',
        message:
          'Bet Lab wallet initialized with registration and monthly credits.',
        userId,
        metadata: { plan: entitlement.plan, welcome, monthly },
      });
      return wallet;
    }

    // Old wallet documents predate the bonus bucket; Mongoose's schema default
    // plus this normalization keeps their existing ledger balance valid.
    if (wallet.bonusBalance == null) wallet.bonusBalance = 0;
    this.assertWalletInvariant(wallet, userId);
    if (wallet.monthlyPeriodEnd.getTime() <= now.getTime()) {
      const oldBalance = wallet.balance;
      const expiredMonthly = wallet.monthlyBalance;
      wallet.monthlyBalance = 0;
      wallet.balance = this.calculateBalance(wallet);

      if (expiredMonthly > 0) {
        await this.ledgerModel.create(
          [
            {
              userId,
              walletId: String(wallet._id),
              transactionType: BetLabLedgerType.MONTHLY_ALLOWANCE_EXPIRY,
              bucket: BetLabCreditBucket.MONTHLY,
              delta: -expiredMonthly,
              amount: expiredMonthly,
              balanceBefore: oldBalance,
              balanceAfter: wallet.balance,
              idempotencyKey: `ALLOWANCE_EXPIRY:${userId}:${this.periodKey(wallet.monthlyPeriodStart, wallet.monthlyPeriodEnd)}`,
              description: 'Unused monthly virtual credits expired',
              metadata: { expiredMonthly },
            },
          ],
          { session, ordered: true },
        );
      }

      const monthly =
        virtualPointsSettings.monthlyAllowanceByPlan[entitlement.plan];
      const periodStart =
        entitlement.periodStart && entitlement.periodStart <= now
          ? entitlement.periodStart
          : now;
      const periodEnd =
        entitlement.periodEnd && entitlement.periodEnd > now
          ? entitlement.periodEnd
          : this.addDays(now, BET_LAB_CONFIG.virtualPoints.allowancePeriodDays);
      const beforeGrant = wallet.balance;
      wallet.monthlyBalance = monthly;
      wallet.balance = this.calculateBalance(wallet);
      wallet.monthlyAllowanceAmount = monthly;
      wallet.monthlyAllowancePlan = entitlement.plan;
      wallet.monthlyPeriodStart = periodStart;
      wallet.monthlyPeriodEnd = periodEnd;
      await wallet.save({ session });
      await this.ledgerModel.create(
        [
          {
            userId,
            walletId: String(wallet._id),
            transactionType: BetLabLedgerType.MONTHLY_ALLOWANCE,
            bucket: BetLabCreditBucket.MONTHLY,
            delta: monthly,
            amount: monthly,
            balanceBefore: beforeGrant,
            balanceAfter: wallet.balance,
            idempotencyKey: `ALLOWANCE:${userId}:${this.periodKey(periodStart, periodEnd)}`,
            description: `${entitlement.plan} Bet Lab allowance`,
            metadata: { plan: entitlement.plan, periodStart, periodEnd },
          },
        ],
        { session, ordered: true },
      );
      await this.events.record({
        level: BetLabEventLevel.INFO,
        category: BetLabEventCategory.WALLET,
        action: 'MONTHLY_ALLOWANCE_REFRESHED',
        message:
          'Expired monthly virtual credits and issued the next allowance.',
        userId,
        metadata: { plan: entitlement.plan, expiredMonthly, monthly },
      });
      return wallet;
    }
    // If an entitlement becomes effective or upgrades during the current monthly
    // period (for example, after email verification activates a Premium bonus),
    // credit only the positive difference. Never claw back credits already
    // granted for this period when an entitlement is downgraded or expires.
    const targetMonthlyAllowance =
      virtualPointsSettings.monthlyAllowanceByPlan[entitlement.plan];
    const currentAllowanceAmount = Number(wallet.monthlyAllowanceAmount ?? 0);
    const additionalAllowance = targetMonthlyAllowance - currentAllowanceAmount;
    if (
      additionalAllowance > 0 &&
      wallet.monthlyAllowancePlan !== entitlement.plan
    ) {
      const balanceBefore = wallet.balance;
      wallet.monthlyBalance += additionalAllowance;
      wallet.monthlyAllowanceAmount = targetMonthlyAllowance;
      wallet.monthlyAllowancePlan = entitlement.plan;
      wallet.balance = this.calculateBalance(wallet);
      await wallet.save({ session });
      await this.ledgerModel.create(
        [
          {
            userId,
            walletId: String(wallet._id),
            transactionType: BetLabLedgerType.MONTHLY_ALLOWANCE,
            bucket: BetLabCreditBucket.MONTHLY,
            delta: additionalAllowance,
            amount: additionalAllowance,
            balanceBefore,
            balanceAfter: wallet.balance,
            idempotencyKey: `ALLOWANCE_UPGRADE:${userId}:${this.periodKey(wallet.monthlyPeriodStart, wallet.monthlyPeriodEnd)}:${entitlement.plan}`,
            description: `Monthly Bet Lab allowance adjustment for ${entitlement.plan} entitlement`,
            metadata: {
              plan: entitlement.plan,
              additionalAllowance,
              periodStart: wallet.monthlyPeriodStart,
              periodEnd: wallet.monthlyPeriodEnd,
            },
          },
        ],
        { session, ordered: true },
      );
    }
    return wallet;
  }

  async getCurrentEntitlement(userId: string): Promise<CurrentEntitlement> {
    const now = new Date();
    const [subscription, bonus] = await Promise.all([
      this.subscriptionsService.getActiveSubscription(userId),
      this.subscriptionsService.getActiveSubscriptionBonus(userId),
    ]);
    const paidPlan = this.normalizePlan(subscription?.plan);
    const bonusPlan = this.normalizePlan(bonus?.plan);
    const rank: Record<BetLabPlan, number> = {
      free: 0,
      regular: 1,
      vip: 2,
      premium: 3,
    };
    const useBonus = rank[bonusPlan] > rank[paidPlan];
    const plan = useBonus ? bonusPlan : paidPlan;
    const matchingEnds = [
      subscription && paidPlan === plan
        ? new Date(subscription.expiryDate)
        : undefined,
      bonus && bonusPlan === plan ? new Date(bonus.expiresAt) : undefined,
    ].filter((date): date is Date => Boolean(date));
    const matchingStarts = [
      subscription && paidPlan === plan
        ? new Date(subscription.startDate)
        : undefined,
      bonus && bonusPlan === plan ? new Date(bonus.startsAt) : undefined,
    ].filter((date): date is Date => Boolean(date));
    return {
      plan,
      periodStart: matchingStarts.length
        ? new Date(Math.min(...matchingStarts.map((date) => date.getTime())))
        : undefined,
      periodEnd: matchingEnds.length
        ? new Date(Math.max(...matchingEnds.map((date) => date.getTime())))
        : undefined,
    };
  }

  /** Credits virtual points to a distinct bonus bucket and writes its ledger row atomically. */
  async grantAdminBonusPoints(
    userId: string,
    points: number,
    reason: string,
    bonusGrantId: string,
  ): Promise<BetLabWalletSnapshot> {
    if (!Number.isSafeInteger(points) || points < 1) {
      throw new ConflictException(
        'Bonus points must be a positive whole number.',
      );
    }
    const entitlement = await this.getCurrentEntitlement(userId);
    const session = await this.walletModel.db.startSession();
    let result: BetLabWalletSnapshot | null = null;
    try {
      await session.withTransaction(async () => {
        const key = `BONUS_GRANT:${bonusGrantId}`;
        const prior = await this.ledgerModel
          .findOne({ idempotencyKey: key })
          .session(session)
          .lean()
          .exec();
        const wallet = await this.ensureWalletInSession(
          userId,
          entitlement,
          session,
        );
        wallet.bonusBalance = wallet.bonusBalance ?? 0;
        if (!prior) {
          this.assertWalletInvariant(wallet, userId);
          const before = wallet.balance;
          wallet.bonusBalance += points;
          wallet.balance = this.calculateBalance(wallet);
          await wallet.save({ session });
          await this.ledgerModel.create(
            [
              {
                userId,
                walletId: String(wallet._id),
                transactionType: BetLabLedgerType.ADMIN_ADJUSTMENT,
                bucket: BetLabCreditBucket.SYSTEM,
                delta: points,
                amount: points,
                balanceBefore: before,
                balanceAfter: wallet.balance,
                idempotencyKey: key,
                description: reason.slice(0, 300),
                metadata: { bonusGrantId, kind: 'BET_LAB_POINTS_BONUS' },
              },
            ],
            { session, ordered: true },
          );
        }
        result = this.toSnapshot(wallet);
      });
    } catch (error) {
      // A duplicate key can be a concurrent wallet-creation race. Do not report
      // success from the existing wallet: the transaction may have rolled back
      // before crediting this grant. Leave the grant pending so an idempotent
      // retry can observe the ledger key and safely complete the operation.
      throw error;
    } finally {
      await session.endSession();
    }
    if (!result)
      throw new InternalServerErrorException(
        'Bonus credit could not be completed.',
      );
    return result;
  }

  /** Reverses a points grant only when the complete grant remains in the bonus bucket. */
  async revokeAdminBonusPoints(
    userId: string,
    points: number,
    reason: string,
    bonusGrantId: string,
  ): Promise<BetLabWalletSnapshot> {
    const entitlement = await this.getCurrentEntitlement(userId);
    const session = await this.walletModel.db.startSession();
    let result: BetLabWalletSnapshot | null = null;
    try {
      await session.withTransaction(async () => {
        const key = `BONUS_REVOCATION:${bonusGrantId}`;
        const prior = await this.ledgerModel
          .findOne({ idempotencyKey: key })
          .session(session)
          .lean()
          .exec();
        const wallet = await this.ensureWalletInSession(
          userId,
          entitlement,
          session,
        );
        wallet.bonusBalance = wallet.bonusBalance ?? 0;
        if (!prior) {
          this.assertWalletInvariant(wallet, userId);
          if (wallet.bonusBalance < points) {
            throw new ConflictException(
              'This bonus has already been spent in part or in full and cannot be automatically reversed.',
            );
          }
          const before = wallet.balance;
          wallet.bonusBalance -= points;
          wallet.balance = this.calculateBalance(wallet);
          await wallet.save({ session });
          await this.ledgerModel.create(
            [
              {
                userId,
                walletId: String(wallet._id),
                transactionType: BetLabLedgerType.ADMIN_ADJUSTMENT,
                bucket: BetLabCreditBucket.SYSTEM,
                delta: -points,
                amount: points,
                balanceBefore: before,
                balanceAfter: wallet.balance,
                idempotencyKey: key,
                description: `Bonus reversal: ${reason}`.slice(0, 300),
                metadata: {
                  bonusGrantId,
                  kind: 'BET_LAB_POINTS_BONUS_REVERSAL',
                },
              },
            ],
            { session, ordered: true },
          );
        }
        result = this.toSnapshot(wallet);
      });
    } finally {
      await session.endSession();
    }
    if (!result)
      throw new InternalServerErrorException(
        'Bonus reversal could not be completed.',
      );
    return result;
  }

  async debitStakeInSession(
    wallet: HydratedDocument<BetLabWallet>,
    userId: string,
    ticketId: string,
    stake: number,
    idempotencyKey: string,
    session: ClientSession,
  ): Promise<void> {
    if (
      !Number.isSafeInteger(stake) ||
      stake < BET_LAB_CONFIG.virtualPoints.minimumStake
    ) {
      throw new ConflictException(
        'Stake must be a positive whole number of virtual points.',
      );
    }
    this.assertWalletInvariant(wallet, userId);
    if (wallet.balance < stake)
      throw new ConflictException(
        'Insufficient virtual points for this stake.',
      );

    const balanceBefore = wallet.balance;
    let remaining = stake;
    const allocation: Record<string, number> = {};

    const fromMonthly = Math.min(wallet.monthlyBalance, remaining);
    wallet.monthlyBalance -= fromMonthly;
    remaining -= fromMonthly;
    allocation.monthly = fromMonthly;

    const fromBonus = Math.min(wallet.bonusBalance ?? 0, remaining);
    wallet.bonusBalance = (wallet.bonusBalance ?? 0) - fromBonus;
    remaining -= fromBonus;
    allocation.bonus = fromBonus;

    const fromWelcome = Math.min(wallet.welcomeBalance, remaining);
    wallet.welcomeBalance -= fromWelcome;
    remaining -= fromWelcome;
    allocation.welcome = fromWelcome;

    const fromWinnings = Math.min(wallet.winningsBalance, remaining);
    wallet.winningsBalance -= fromWinnings;
    remaining -= fromWinnings;
    allocation.winnings = fromWinnings;

    if (remaining !== 0)
      throw new InternalServerErrorException(
        'Wallet credit buckets do not reconcile with the displayed balance.',
      );
    wallet.balance = this.calculateBalance(wallet);
    wallet.totalStaked += stake;
    wallet.netProfitLoss = wallet.totalReturns - wallet.totalStaked;
    wallet.ticketsPlaced += 1;
    wallet.lastTicketAt = new Date();
    await wallet.save({ session });
    await this.ledgerModel.create(
      [
        {
          userId,
          walletId: String(wallet._id),
          transactionType: BetLabLedgerType.STAKE_DEBIT,
          bucket: BetLabCreditBucket.MIXED,
          delta: -stake,
          amount: stake,
          balanceBefore,
          balanceAfter: wallet.balance,
          ticketId,
          idempotencyKey,
          description: 'Virtual stake placed in Bet Lab',
          metadata: { allocation },
        },
      ],
      { session, ordered: true },
    );
  }

  async creditSettlementReturnInSession(
    wallet: HydratedDocument<BetLabWallet>,
    userId: string,
    ticketId: string,
    settlementId: string,
    grossReturn: number,
    ledgerType: BetLabLedgerType,
    session: ClientSession,
  ): Promise<void> {
    if (
      !Number.isSafeInteger(grossReturn) ||
      grossReturn < 0 ||
      grossReturn > BET_LAB_CONFIG.virtualPoints.maximumPotentialReturn
    ) {
      throw new ConflictException(
        'Settlement supplied an invalid gross return.',
      );
    }
    this.assertWalletInvariant(wallet, userId);
    const balanceBefore = wallet.balance;
    if (grossReturn > 0) {
      wallet.winningsBalance += grossReturn;
      wallet.balance = this.calculateBalance(wallet);
      wallet.totalReturns += grossReturn;
      wallet.netProfitLoss = wallet.totalReturns - wallet.totalStaked;
      await wallet.save({ session });
    }
    await this.ledgerModel.create(
      [
        {
          userId,
          walletId: String(wallet._id),
          transactionType: ledgerType,
          bucket: BetLabCreditBucket.WINNINGS,
          delta: grossReturn,
          amount: grossReturn,
          balanceBefore,
          balanceAfter: wallet.balance,
          ticketId,
          idempotencyKey: `SETTLEMENT_RETURN:${ticketId}:${settlementId}`,
          description:
            grossReturn > 0
              ? 'Virtual return applied from the separate Settlement module'
              : 'Settlement outcome recorded; no virtual return was credited',
          metadata: { settlementId, grossReturn },
        },
      ],
      { session, ordered: true },
    );
  }

  toSnapshot(wallet: any): BetLabWalletSnapshot {
    const createdAt = (
      wallet as {
        createdAt?: string | number | Date | null;
      }
    ).createdAt;
    const lastTicketAt = (
      wallet as {
        lastTicketAt?: string | number | Date | null;
      }
    ).lastTicketAt;

    return {
      walletId: String((wallet as { _id?: unknown })._id),
      userId: String((wallet as { userId?: unknown }).userId),
      balance: Number((wallet as { balance?: number | null }).balance),
      welcomeBalance: Number(
        (wallet as { welcomeBalance?: number | null }).welcomeBalance,
      ),
      monthlyBalance: Number(
        (wallet as { monthlyBalance?: number | null }).monthlyBalance,
      ),
      winningsBalance: Number(
        (wallet as { winningsBalance?: number | null }).winningsBalance,
      ),
      bonusBalance: Number(
        (wallet as { bonusBalance?: number | null }).bonusBalance ?? 0,
      ),
      registrationBonusGranted: Boolean(
        (wallet as { registrationBonusGranted?: unknown })
          .registrationBonusGranted,
      ),
      monthlyAllowanceAmount: Number(
        (wallet as { monthlyAllowanceAmount?: number | null })
          .monthlyAllowanceAmount,
      ),
      monthlyAllowancePlan: this.normalizePlan(
        (wallet as { monthlyAllowancePlan?: unknown }).monthlyAllowancePlan,
      ),
      monthlyPeriodStart: new Date(
        (wallet as { monthlyPeriodStart: string | number | Date })
          .monthlyPeriodStart,
      ),
      monthlyPeriodEnd: new Date(
        (wallet as { monthlyPeriodEnd: string | number }).monthlyPeriodEnd,
      ),
      totalStaked: Number(
        (wallet as { totalStaked?: number | null }).totalStaked,
      ),
      totalReturns: Number(
        (wallet as { totalReturns?: number | null }).totalReturns,
      ),
      netProfitLoss: Number(
        (wallet as { netProfitLoss?: number | null }).netProfitLoss,
      ),
      ticketsPlaced: Number(
        (wallet as { ticketsPlaced?: number | null }).ticketsPlaced ?? 0,
      ),
      ticketsSettled: Number(
        (wallet as { ticketsSettled?: number | null }).ticketsSettled ?? 0,
      ),
      ticketsWon: Number(
        (wallet as { ticketsWon?: number | null }).ticketsWon ?? 0,
      ),
      ticketsLost: Number(
        (wallet as { ticketsLost?: number | null }).ticketsLost ?? 0,
      ),
      ticketsVoided: Number(
        (wallet as { ticketsVoided?: number | null }).ticketsVoided ?? 0,
      ),
      ticketsPushed: Number(
        (wallet as { ticketsPushed?: number | null }).ticketsPushed ?? 0,
      ),
      ticketsPartiallyWon: Number(
        (wallet as { ticketsPartiallyWon?: number | null })
          .ticketsPartiallyWon ?? 0,
      ),
      ticketsPartiallyLost: Number(
        (wallet as { ticketsPartiallyLost?: number | null })
          .ticketsPartiallyLost ?? 0,
      ),
      lastTicketAt: lastTicketAt ? new Date(lastTicketAt) : undefined,
      createdAt: createdAt ? new Date(createdAt) : undefined,
      updatedAt: (wallet as { updatedAt?: string | number | Date | null })
        .updatedAt
        ? new Date(
            (wallet as { updatedAt?: string | number | Date | null })
              .updatedAt!,
          )
        : undefined,
    };
  }

  normalizePlan(value: unknown): BetLabPlan {
    const plan =
      typeof value === 'string' ? value.trim().toLowerCase() : 'free';
    if (plan === 'regular' || plan === 'vip' || plan === 'premium') return plan;
    return 'free';
  }

  calculateBalance(wallet: {
    welcomeBalance: number;
    monthlyBalance: number;
    winningsBalance: number;
    bonusBalance?: number | null;
  }): number {
    return (
      wallet.welcomeBalance +
      wallet.monthlyBalance +
      (wallet.bonusBalance ?? 0) +
      wallet.winningsBalance
    );
  }

  private assertWalletInvariant(
    wallet: {
      balance: number;
      welcomeBalance: number;
      monthlyBalance: number;
      winningsBalance: number;
      bonusBalance?: number | null;
    },
    userId: string,
  ): void {
    const calculated = this.calculateBalance(wallet);
    if (
      !Number.isSafeInteger(calculated) ||
      calculated < 0 ||
      wallet.balance !== calculated
    ) {
      const message = `Bet Lab wallet balance invariant failed for user ${userId}: stored=${wallet.balance}, buckets=${calculated}`;
      this.logger.error(message);
      void this.events.record({
        level: BetLabEventLevel.ERROR,
        category: BetLabEventCategory.WALLET,
        action: 'WALLET_BALANCE_INVARIANT_FAILED',
        message,
        userId,
        metadata: { storedBalance: wallet.balance, bucketTotal: calculated },
      });
      throw new InternalServerErrorException(
        'Wallet accounting requires review. Please try again later.',
      );
    }
  }

  private addDays(date: Date, days: number): Date {
    return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
  }

  private periodKey(start: Date, end: Date): string {
    return `${start.getTime()}-${end.getTime()}`;
  }

  private isDuplicateKey(error: unknown): boolean {
    return Boolean(
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === 11000,
    );
  }
}
