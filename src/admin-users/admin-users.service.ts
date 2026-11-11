import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AdminUserQueryDto } from './dto/admin-user-query.dto';
import { SuspendUserDto } from './dto/suspend-user.dto';
import { AdminUserAudit } from './schemas/admin-user-audit.schema';
import { UsersService } from '../users/users.service';
import { PaymentsService } from '../payments/payments.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { UserSessionService } from '../user-session/user-session.service';
import { BetLabTicketService } from '../bet-lab/services/bet-lab-ticket.service';
import { BetLabWalletService } from '../bet-lab/services/bet-lab-wallet.service';
import { BetLabWalletHistoryService } from '../bet-lab/services/bet-lab-wallet-history.service';
import { ReferralsService } from '../referrals/referrals.service';
import { PromoEngineService } from '../promos/promo-engine.service';
import { BonusesService } from '../bonuses/bonuses.service';
import { WebsiteAnalyticsAggregationService } from '../website-analytics/website-analytics-aggregation.service';
import { PredictionAccessService } from '../prediction-access/prediction-access.service';
import { NotificationEventsService } from '../notifications/in-app/notification-events.service';

@Injectable()
export class AdminUsersService {
  constructor(
    @InjectModel(AdminUserAudit.name)
    private readonly auditModel: Model<AdminUserAudit>,
    private readonly usersService: UsersService,
    private readonly paymentsService: PaymentsService,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly sessionsService: UserSessionService,
    private readonly betLabTickets: BetLabTicketService,
    private readonly betLabWallet: BetLabWalletService,
    private readonly betLabWalletHistory: BetLabWalletHistoryService,
    private readonly referralsService: ReferralsService,
    private readonly promoEngine: PromoEngineService,
    private readonly bonusesService: BonusesService,
    private readonly websiteAnalytics: WebsiteAnalyticsAggregationService,
    private readonly predictionAccess: PredictionAccessService,
    private readonly notificationEvents: NotificationEventsService,
  ) {}

  async getUsers(query: AdminUserQueryDto) {
    if (query.plan && query.plan !== 'all') {
      const planFilter = await this.subscriptionsService.getUserIdFilterForPlan(query.plan);
      return this.usersService.findAll({ ...query, ...planFilter });
    }
    return this.usersService.findAll(query);
  }

  async getUserDetails(userId: string) {
    const user = await this.usersService.findById(userId);
    if (!user) throw new NotFoundException('User not found.');

    const safeUser: Record<string, any> = {
      ...user.toObject(),
      _id: String(user._id),
    };
    delete safeUser.password;
    delete safeUser.passwordResetToken;
    delete safeUser.passwordResetExpires;

    const sectionNames = [
      'payments', 'subscription', 'sessions', 'betLab.wallet',
      'betLab.tickets', 'betLab.ledger', 'referrals', 'promotions.rewards',
      'promotions.progress', 'bonuses', 'websiteAnalytics', 'predictionAccess',
    ];
    const results = await Promise.allSettled([
      this.paymentsService.getUserPaymentAdminSummary(userId),
      this.subscriptionsService.getSubscriptionSummary(userId),
      this.sessionsService.getSessionSummary(userId),
      this.betLabWallet.getExistingWalletSnapshot(userId),
      this.betLabTickets.listTickets(userId, { page: 1, limit: 10 }),
      this.betLabWalletHistory.list(userId, 1, 10),
      this.referralsService.getUserReferralsPaginated(userId, 1, 10),
      this.promoEngine.getUserRewardsPaginated(userId, 1, 10),
      this.promoEngine.getUserPromoProgress(userId),
      this.bonusesService.getAdminBonuses({ userId, page: 1, limit: 10 }),
      this.websiteAnalytics.getUserAnalytics(userId),
      this.predictionAccess.getAccessPlan({ _id: userId } as any),
    ]);

    const values = results.map((result) =>
      result.status === 'fulfilled' ? result.value : null,
    );
    const sectionErrors = results.flatMap((result, index) =>
      result.status === 'rejected'
        ? [{
            section: sectionNames[index],
            message: result.reason instanceof Error
              ? result.reason.message
              : 'Section unavailable',
          }]
        : [],
    );

    return {
      user: safeUser,
      payments: values[0],
      subscription: values[1],
      sessions: values[2],
      betLab: { wallet: values[3], tickets: values[4], ledger: values[5] },
      referrals: values[6] ?? [],
      promotions: { rewards: values[7] ?? [], progress: values[8] },
      bonuses: values[9],
      websiteAnalytics: values[10],
      predictionAccess: { plan: values[11] },
      partial: sectionErrors.length > 0,
      sectionErrors,
    };
  }

  getPaymentHistory(userId: string, page?: number, limit?: number) {
    return this.paymentsService.getUserPaymentHistory(userId, page, limit);
  }

  getSubscriptionHistory(userId: string, page?: number, limit?: number) {
    return this.subscriptionsService.getUserSubscriptionHistory(userId, page, limit);
  }

  getBetLabTickets(userId: string, page?: string, limit?: string, status?: string) {
    return this.betLabTickets.listTickets(userId, {
      page: this.safeNumber(page, 1),
      limit: this.safeNumber(limit, 10),
      ...(status ? { status: status as any } : {}),
    });
  }

  getBetLabLedger(userId: string, page?: string, limit?: string) {
    return this.betLabWalletHistory.list(
      userId,
      this.safeNumber(page, 1),
      this.safeNumber(limit, 10),
    );
  }

  getReferrals(userId: string, page?: string, limit?: string) {
    return this.referralsService.getUserReferralsPaginated(
      userId,
      this.safeNumber(page, 1),
      this.safeNumber(limit, 10),
    );
  }

  getPromotionRewards(userId: string, page?: string, limit?: string) {
    return this.promoEngine.getUserRewardsPaginated(
      userId,
      this.safeNumber(page, 1),
      this.safeNumber(limit, 10),
    );
  }

  getBonuses(userId: string, page?: string, limit?: string) {
    return this.bonusesService.getAdminBonuses({
      userId,
      page: this.safeNumber(page, 1),
      limit: this.safeNumber(limit, 10),
    });
  }

  async suspendUser(userId: string, data: SuspendUserDto, adminId: string) {
    const result = await this.usersService.suspendUser(userId, data, adminId);
    await this.writeAudit(userId, adminId, 'suspend', data.reason ?? '', null, {
      bannedUntil: data.bannedUntil ?? null,
    });
    await this.notificationEvents.accountSuspended({
      userId,
      reason: data.reason,
      bannedUntil: data.bannedUntil ?? null,
    });
    return result;
  }

  async activateUser(userId: string, adminId?: string) {
    const result = await this.usersService.activateUser(userId);
    if (adminId) await this.writeAudit(userId, adminId, 'activate');
    await this.notificationEvents.accountRestored({ userId });
    return result;
  }

  async deleteUser(userId: string, adminId: string) {
    const result = await this.usersService.softDeleteUser(userId, adminId);
    await this.writeAudit(userId, adminId, 'delete');
    return result;
  }

  async logoutAll(userId: string, adminId?: string) {
    const result = await this.sessionsService.deactivateAllUserSessions(userId);
    if (adminId) await this.writeAudit(userId, adminId, 'logout_all');
    await this.notificationEvents.accountSecurityAlert({
      userId,
      eventKey: `admin-logout-all:${Date.now()}`,
      title: 'Security Notice: Sessions Signed Out',
      message: 'An administrator signed out all active sessions on your account. Sign in again only if you recognise this action.',
    });
    return result;
  }

  getUserSessions(userId: string) {
    return this.sessionsService.getUserSessions(userId);
  }

  async revokeSession(sessionId: string, userId: string, adminId?: string) {
    const result = await this.sessionsService.revokeSession(sessionId, userId);
    if (adminId) {
      await this.writeAudit(userId, adminId, 'revoke_session', '', sessionId);
      await this.notificationEvents.accountSecurityAlert({
        userId,
        eventKey: `admin-session-revoked:${sessionId}`,
        title: 'Security Notice: Session Revoked',
        message: 'An administrator signed out one of your active sessions. Review your account security if you do not recognise this action.',
      });
    }
    return result;
  }

  async getAuditHistory(userId: string, pageValue = 1, limitValue = 20) {
    const page = this.safeNumber(pageValue, 1);
    const limit = Math.min(100, this.safeNumber(limitValue, 20));
    const filter = { userId: new Types.ObjectId(userId) };
    const [items, total] = await Promise.all([
      this.auditModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('adminId', 'fullName username email')
        .lean()
        .exec(),
      this.auditModel.countDocuments(filter).exec(),
    ]);
    return { items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  private async writeAudit(
    userId: string,
    adminId: string,
    action: 'suspend' | 'activate' | 'delete' | 'logout_all' | 'revoke_session',
    reason = '',
    targetId: string | null = null,
    metadata: Record<string, unknown> = {},
  ) {
    if (!Types.ObjectId.isValid(userId) || !Types.ObjectId.isValid(adminId)) return;
    await this.auditModel.create({
      userId: new Types.ObjectId(userId),
      adminId: new Types.ObjectId(adminId),
      action,
      reason,
      targetId,
      metadata,
    });
  }

  private safeNumber(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0
      ? Math.min(100, Math.floor(parsed))
      : fallback;
  }
}

