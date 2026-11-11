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
import { NotificationEventsService } from '../../notifications/in-app/notification-events.service';

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
    private readonly notificationEvents: NotificationEventsService,
  ) {}

  // Read-only admin inspection. Unlike getWallet(), this never creates a wallet
  // or grants a first-login/monthly allowance merely because an admin opened a profile.
  async getExistingWalletSnapshot(
    userId: string,
  ): Promise<BetLabWalletSnapshot | null> {
    const wallet = await this.walletModel.findOne({ userId }).lean().exec();
    return wallet ? this.toSnapshot(wallet) : null;
  }

  /** Read-only wallet snapshot for an already committed ticket replay. */
  async getExistingWalletSnapshotInSession(
    userId: string,
    session: ClientSession,
  ): Promise<BetLabWalletSnapshot | null> {
    const wallet = await this.walletModel
      .findOne({ userId })
      .session(session)
      .exec();
    return wallet ? this.toSnapshot(wallet) : null;
  }

  async getWallet(userId: string): Promise<BetLabWalletSnapshot> {
    const allowanceWindowStart = new Date(Date.now() - 1000);
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
        if (racedWallet) snapshot = this.toSnapshot(racedWallet);
        else throw error;
      } else {
        throw error;
      }
    } finally {
      await session.endSession();
    }
    if (!snapshot)
      throw new InternalServerErrorException(
        'Bet Lab wallet could not be loaded',
      );
    await this.notifyAllowanceCredits(userId, allowanceWindowStart);
    return snapshot;
  }

  /**
   * Queue idempotent notices for allowance ledger entries committed by the caller.
   * The ledger entry ID is the notification deduplication reference.
   */
  async dispatchRecentAllowanceNotifications(
    userId: string,
    since: Date,
  ): Promise<void> {
    await this.notifyAllowanceCredits(userId, since);
  }

  private async notifyAllowanceCredits(
    userId: string,
    since: Date,
  ): Promise<void> {
    try {
      const entries = await this.ledgerModel
        .find({
          userId,
          createdAt: { $gte: since },
          transactionType: {
            $in: [
              BetLabLedgerType.REGISTRATION_BONUS,
              BetLabLedgerType.MONTHLY_ALLOWANCE,
              BetLabLedgerType.MONTHLY_ALLOWANCE_EXPIRY,
            ],
          },
          delta: { $ne: 0 },
        })
        .sort({ createdAt: 1 })
        .limit(10)
        .lean()
        .exec();

      for (const entry of entries) {
        const createdAt = (entry as { createdAt?: Date | string | number })
          .createdAt;
        if (
          entry.transactionType === BetLabLedgerType.MONTHLY_ALLOWANCE_EXPIRY &&
          Number(entry.delta) < 0
        ) {
          await this.notificationEvents.walletAllowanceExpired({
            userId,
            transactionId: String(entry._id),
            amount: Math.abs(Number(entry.delta)),
            expiredAt: createdAt ? new Date(createdAt) : undefined,
          });
          continue;
        }
        if (Number(entry.delta) > 0) {
          await this.notificationEvents.walletCredited({
            userId,
            transactionId: String(entry._id),
            amount: Number(entry.delta),
            balanceAfter: Number(entry.balanceAfter),
            description: String(
              entry.description ?? 'Bet Lab virtual points allowance',
            ),
            source: String(entry.transactionType),
          });
        }
      }
    } catch (error) {
      // Notification lookup/delivery must never break a committed wallet action.
      this.logger.warn(
        `Could not queue Bet Lab allowance notifications for user ${userId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
      const allowanceWindow = this.getAllowanceWindow(
        now,
        entitlement.periodStart,
      );
      const { periodStart, periodEnd } = allowanceWindow;
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

    // Older wallets may not contain the bonus bucket or may have allowance
    // windows that were tied to a full subscription expiry. Normalize the
    // accounting buckets and restore the configured 30-day allowance cadence.
    if (wallet.bonusBalance == null) wallet.bonusBalance = 0;

    const periodMs =
      BET_LAB_CONFIG.virtualPoints.allowancePeriodDays * 24 * 60 * 60 * 1000;
    const storedPeriodStart = this.toValidDate(wallet.monthlyPeriodStart);
    const periodStart =
      storedPeriodStart && storedPeriodStart.getTime() <= now.getTime()
        ? storedPeriodStart
        : new Date(now.getTime() - periodMs);
    const periodEnd = this.addDays(
      periodStart,
      BET_LAB_CONFIG.virtualPoints.allowancePeriodDays,
    );
    const periodMetadataChanged =
      !storedPeriodStart ||
      storedPeriodStart.getTime() !== periodStart.getTime() ||
      !this.toValidDate(wallet.monthlyPeriodEnd) ||
      this.toValidDate(wallet.monthlyPeriodEnd)!.getTime() !==
        periodEnd.getTime();
    wallet.monthlyPeriodStart = periodStart;
    wallet.monthlyPeriodEnd = periodEnd;

    this.assertWalletInvariant(wallet, userId);
    if (periodEnd.getTime() <= now.getTime()) {
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
              idempotencyKey: `ALLOWANCE_EXPIRY:${userId}:${this.periodKey(periodStart, periodEnd)}`,
              description: 'Unused monthly virtual credits expired',
              metadata: { expiredMonthly, periodStart, periodEnd },
            },
          ],
          { session, ordered: true },
        );
      }

      const monthly =
        virtualPointsSettings.monthlyAllowanceByPlan[entitlement.plan];
      const nextWindow = this.getAllowanceWindow(
        now,
        entitlement.periodStart,
      );
      const beforeGrant = wallet.balance;
      wallet.monthlyBalance = monthly;
      wallet.balance = this.calculateBalance(wallet);
      wallet.monthlyAllowanceAmount = monthly;
      wallet.monthlyAllowancePlan = entitlement.plan;
      wallet.monthlyPeriodStart = nextWindow.periodStart;
      wallet.monthlyPeriodEnd = nextWindow.periodEnd;
      this.assertWalletInvariant(wallet, userId);
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
            idempotencyKey: `ALLOWANCE:${userId}:${this.periodKey(nextWindow.periodStart, nextWindow.periodEnd)}`,
            description: `${entitlement.plan} Bet Lab allowance`,
            metadata: {
              plan: entitlement.plan,
              periodStart: nextWindow.periodStart,
              periodEnd: nextWindow.periodEnd,
            },
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

    if (periodMetadataChanged) {
      await wallet.save({ session });
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
      this.assertWalletInvariant(wallet, userId);
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
    const entitlement =
      await this.subscriptionsService.getEffectiveEntitlement(userId);
    const plan = this.normalizePlan(entitlement.plan);
    const subscription = entitlement.subscription;
    const bonus = entitlement.bonus;

    // Preserve the wallet's existing allowance-window rule: when a paid term
    // and a bonus provide the same effective tier, use their combined window.
    // When the bonus is a higher tier, the lower paid tier is not part of it.
    const matchingEnds = [
      subscription && this.normalizePlan(subscription.plan) === plan
        ? new Date(subscription.expiryDate)
        : undefined,
      bonus && this.normalizePlan(bonus.plan) === plan
        ? new Date(bonus.expiresAt)
        : undefined,
    ].filter((date): date is Date => Boolean(date));
    const matchingStarts = [
      subscription && this.normalizePlan(subscription.plan) === plan
        ? new Date(subscription.startDate)
        : undefined,
      bonus && this.normalizePlan(bonus.plan) === plan
        ? new Date(bonus.startsAt)
        : undefined,
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
    const allowanceWindowStart = new Date(Date.now() - 1000);
    if (!Number.isSafeInteger(points) || points < 1) {
      throw new ConflictException(
        'Bonus points must be a positive whole number.',
      );
    }
    const normalizedGrantId = String(bonusGrantId ?? '').trim();
    if (!normalizedGrantId || normalizedGrantId.length > 160) {
      throw new ConflictException('A valid bonus grant reference is required.');
    }
    const safeReason = String(reason ?? '').trim().slice(0, 300) || 'Admin Bet Lab bonus credit';
    const entitlement = await this.getCurrentEntitlement(userId);
    const session = await this.walletModel.db.startSession();
    let result: BetLabWalletSnapshot | null = null;
    try {
      await session.withTransaction(async () => {
        const key = `BONUS_GRANT:${normalizedGrantId}`;
        const prior = await this.ledgerModel
          .findOne({ userId, idempotencyKey: key })
          .session(session)
          .lean()
          .exec();
        const wallet = await this.ensureWalletInSession(
          userId,
          entitlement,
          session,
        );
        wallet.bonusBalance = wallet.bonusBalance ?? 0;
        this.assertWalletInvariant(wallet, userId);
        if (prior) {
          const priorBucket = String(prior.bucket ?? '').toUpperCase();
          if (
            prior.userId !== userId ||
            prior.transactionType !== BetLabLedgerType.ADMIN_ADJUSTMENT ||
            !['BONUS', 'SYSTEM'].includes(priorBucket) ||
            Number(prior.delta) !== points ||
            Number(prior.amount) !== points ||
            prior.metadata?.kind !== 'BET_LAB_POINTS_BONUS' ||
            String(prior.metadata?.bonusGrantId ?? '') !== normalizedGrantId
          ) {
            throw new ConflictException(
              'This bonus grant reference has already been used for a different credit.',
            );
          }
        } else {
          const before = wallet.balance;
          wallet.bonusBalance += points;
          wallet.balance = this.calculateBalance(wallet);
          this.assertWalletInvariant(wallet, userId);
          await wallet.save({ session });
          await this.ledgerModel.create(
            [
              {
                userId,
                walletId: String(wallet._id),
                transactionType: BetLabLedgerType.ADMIN_ADJUSTMENT,
                bucket: BetLabCreditBucket.BONUS,
                delta: points,
                amount: points,
                balanceBefore: before,
                balanceAfter: wallet.balance,
                idempotencyKey: key,
                description: safeReason,
                metadata: {
                  bonusGrantId: normalizedGrantId,
                  kind: 'BET_LAB_POINTS_BONUS',
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
        'Bonus credit could not be completed.',
      );
    await this.notifyAllowanceCredits(userId, allowanceWindowStart);
    return result;
  }

  /** Reverses a grant only when the aggregate bonus bucket can cover its full amount. */
  async revokeAdminBonusPoints(
    userId: string,
    points: number,
    reason: string,
    bonusGrantId: string,
  ): Promise<BetLabWalletSnapshot> {
    const allowanceWindowStart = new Date(Date.now() - 1000);
    if (!Number.isSafeInteger(points) || points < 1) {
      throw new ConflictException(
        'Bonus reversal points must be a positive whole number.',
      );
    }
    const normalizedGrantId = String(bonusGrantId ?? '').trim();
    if (!normalizedGrantId || normalizedGrantId.length > 160) {
      throw new ConflictException('A valid bonus grant reference is required.');
    }
    const safeReason = String(reason ?? '').trim().slice(0, 300) || 'Admin Bet Lab bonus reversal';
    const entitlement = await this.getCurrentEntitlement(userId);
    const session = await this.walletModel.db.startSession();
    let result: BetLabWalletSnapshot | null = null;
    try {
      await session.withTransaction(async () => {
        const key = `BONUS_REVOCATION:${normalizedGrantId}`;
        const prior = await this.ledgerModel
          .findOne({ userId, idempotencyKey: key })
          .session(session)
          .lean()
          .exec();
        const originalGrant = await this.ledgerModel
          .findOne({
            userId,
            idempotencyKey: `BONUS_GRANT:${normalizedGrantId}`,
          })
          .session(session)
          .lean()
          .exec();
        const wallet = await this.ensureWalletInSession(
          userId,
          entitlement,
          session,
        );
        wallet.bonusBalance = wallet.bonusBalance ?? 0;
        this.assertWalletInvariant(wallet, userId);
        const originalBucket = String(originalGrant?.bucket ?? '').toUpperCase();
        if (
          !originalGrant ||
          originalGrant.transactionType !== BetLabLedgerType.ADMIN_ADJUSTMENT ||
          !['BONUS', 'SYSTEM'].includes(originalBucket) ||
          Number(originalGrant.delta) !== points ||
          Number(originalGrant.amount) !== points ||
          originalGrant.metadata?.kind !== 'BET_LAB_POINTS_BONUS' ||
          String(originalGrant.metadata?.bonusGrantId ?? '') !== normalizedGrantId
        ) {
          throw new ConflictException(
            'The original bonus grant could not be verified for this user and amount.',
          );
        }
        const priorBucket = String(prior?.bucket ?? '').toUpperCase();
        if (
          prior &&
          (prior.userId !== userId ||
            prior.transactionType !== BetLabLedgerType.ADMIN_ADJUSTMENT ||
            !['BONUS', 'SYSTEM'].includes(priorBucket) ||
            Number(prior.delta) !== -points ||
            Number(prior.amount) !== points ||
            prior.metadata?.kind !== 'BET_LAB_POINTS_BONUS_REVERSAL' ||
            String(prior.metadata?.bonusGrantId ?? '') !== normalizedGrantId)
        ) {
          throw new ConflictException(
            'This bonus reversal reference has already been used for a different reversal.',
          );
        }
        if (!prior) {
          if (wallet.bonusBalance < points) {
            throw new ConflictException(
              'The bonus bucket no longer contains enough unspent credits to reverse this grant.',
            );
          }
          const before = wallet.balance;
          wallet.bonusBalance -= points;
          wallet.balance = this.calculateBalance(wallet);
          this.assertWalletInvariant(wallet, userId);
          await wallet.save({ session });
          await this.ledgerModel.create(
            [
              {
                userId,
                walletId: String(wallet._id),
                transactionType: BetLabLedgerType.ADMIN_ADJUSTMENT,
                bucket: BetLabCreditBucket.BONUS,
                delta: -points,
                amount: points,
                balanceBefore: before,
                balanceAfter: wallet.balance,
                idempotencyKey: key,
                description: `Bonus reversal: ${safeReason}`.slice(0, 300),
                metadata: {
                  bonusGrantId: normalizedGrantId,
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
    await this.notifyAllowanceCredits(userId, allowanceWindowStart);
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
    if (!String(idempotencyKey ?? '').trim()) {
      throw new ConflictException('A wallet stake idempotency key is required.');
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
    this.assertWalletInvariant(wallet, userId);
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
    if (!String(ticketId ?? '').trim() || !String(settlementId ?? '').trim()) {
      throw new ConflictException(
        'A ticket ID and settlement ID are required for wallet settlement.',
      );
    }
    if (
      ledgerType !== BetLabLedgerType.SETTLEMENT_RETURN &&
      ledgerType !== BetLabLedgerType.VOID_OR_PUSH_RETURN
    ) {
      throw new ConflictException('Invalid Bet Lab settlement ledger type.');
    }
    this.assertWalletInvariant(wallet, userId);
    const balanceBefore = wallet.balance;
    if (grossReturn > 0) {
      wallet.winningsBalance += grossReturn;
      wallet.balance = this.calculateBalance(wallet);
      wallet.totalReturns += grossReturn;
      wallet.netProfitLoss = wallet.totalReturns - wallet.totalStaked;
      this.assertWalletInvariant(wallet, userId);
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
    const buckets = [
      wallet.welcomeBalance,
      wallet.monthlyBalance,
      wallet.bonusBalance ?? 0,
      wallet.winningsBalance,
    ];
    const bucketsValid = buckets.every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    );
    const calculated = this.calculateBalance(wallet);
    if (
      !bucketsValid ||
      !Number.isSafeInteger(wallet.balance) ||
      wallet.balance < 0 ||
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

  private toValidDate(value: unknown): Date | null {
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value;
    }
    if (typeof value === 'string' || typeof value === 'number') {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    return null;
  }

  /**
   * Produces a rolling 30-day allowance window anchored to the effective
   * entitlement start where available. Subscription expiry must never extend a
   * single monthly allowance across multiple months.
   */
  private getAllowanceWindow(
    now: Date,
    entitlementStart?: Date,
  ): { periodStart: Date; periodEnd: Date } {
    const periodDays = BET_LAB_CONFIG.virtualPoints.allowancePeriodDays;
    const periodMs = periodDays * 24 * 60 * 60 * 1000;
    const validAnchor = this.toValidDate(entitlementStart);
    const anchor =
      validAnchor && validAnchor.getTime() <= now.getTime()
        ? validAnchor
        : now;
    const elapsed = Math.max(0, now.getTime() - anchor.getTime());
    const completedPeriods = Math.floor(elapsed / periodMs);
    const periodStart = new Date(
      anchor.getTime() + completedPeriods * periodMs,
    );
    return {
      periodStart,
      periodEnd: this.addDays(periodStart, periodDays),
    };
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

