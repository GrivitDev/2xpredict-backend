import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Promo } from './schemas/promo.schema';
import { PromoReward } from './schemas/promo-reward.schema';
import { PromoRewardStatus } from './constants/promo-reward-status';
import { PromoParticipant } from './schemas/promo-participant.schema';
import { PromoRedemption, PromoRedemptionStatus } from './schemas/promo-redemption.schema';
import { PromoClaim, PromoClaimStatus } from './schemas/promo-claim.schema';
import { SystemMonitorService } from '../system-monitor/system-monitor.service';

type MonitorCheck = { name: string; status: 'OK' | 'FAILED'; value?: unknown; error?: string };

@Injectable()
export class PromosMonitorService implements OnModuleInit {
  onModuleInit(): void {
    this.systemMonitor.registerModule('promos');
  }

  constructor(
    @InjectModel(Promo.name) private readonly promoModel: Model<Promo>,
    @InjectModel(PromoReward.name) private readonly rewardModel: Model<PromoReward>,
    @InjectModel(PromoParticipant.name) private readonly participantModel: Model<PromoParticipant>,
    @InjectModel(PromoRedemption.name) private readonly redemptionModel: Model<PromoRedemption>,
    @InjectModel(PromoClaim.name) private readonly claimModel: Model<PromoClaim>,
    private readonly systemMonitor: SystemMonitorService,
  ) {}

  private async safeQuery<T>(checks: MonitorCheck[], name: string, query: () => Promise<T>, fallback: T): Promise<T> {
    try {
      const value = await query();
      checks.push({ name, status: 'OK', value });
      return value;
    } catch (error) {
      checks.push({ name, status: 'FAILED', error: error instanceof Error ? error.message : 'Query failed' });
      return fallback;
    }
  }

  async getOverview() {
    try {
      return await this.buildOverview();
    } catch (error) {
      this.systemMonitor.reportMonitorSnapshot('promos', {
        status: 'FAILED',
        checkedAt: new Date(),
        checks: [{ name: 'getOverview', status: 'FAILED', error: error instanceof Error ? error.message : String(error) }],
      });
      throw error;
    }
  }

  private async buildOverview() {
    const checkedAt = new Date();
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const checks: MonitorCheck[] = [];
    const databaseReady = this.promoModel.db.readyState === 1;

    const [
      totalPromos, activePromos, currentlyRunning, upcomingActive, expiredActive,
      totalRewards, pendingRewards, approvedRewards, paidRewards, rewardsLast24Hours,
      participants, totalRedemptions, reservedRedemptions, redeemedRedemptions, releasedRedemptions,
      totalClaims, activeClaims, usedClaims, expiredClaims, staleReservations,
    ] = await Promise.all([
      this.safeQuery(checks, 'promos.total', () => this.promoModel.countDocuments({}).exec(), 0),
      this.safeQuery(checks, 'promos.active', () => this.promoModel.countDocuments({ isActive: true }).exec(), 0),
      this.safeQuery(checks, 'promos.running', () => this.promoModel.countDocuments({ isActive: true, startDate: { $lte: now }, endDate: { $gte: now } }).exec(), 0),
      this.safeQuery(checks, 'promos.upcoming', () => this.promoModel.countDocuments({ isActive: true, startDate: { $gt: now } }).exec(), 0),
      this.safeQuery(checks, 'promos.expired-but-active', () => this.promoModel.countDocuments({ isActive: true, endDate: { $lt: now } }).exec(), 0),
      this.safeQuery(checks, 'rewards.total', () => this.rewardModel.countDocuments({}).exec(), 0),
      this.safeQuery(checks, 'rewards.pending', () => this.rewardModel.countDocuments({ status: PromoRewardStatus.PENDING }).exec(), 0),
      this.safeQuery(checks, 'rewards.approved', () => this.rewardModel.countDocuments({ status: PromoRewardStatus.APPROVED }).exec(), 0),
      this.safeQuery(checks, 'rewards.paid', () => this.rewardModel.countDocuments({ status: PromoRewardStatus.PAID }).exec(), 0),
      this.safeQuery(checks, 'rewards.created-24-hours', () => this.rewardModel.countDocuments({ createdAt: { $gte: dayAgo } }).exec(), 0),
      this.safeQuery(checks, 'participants.total', () => this.participantModel.countDocuments({}).exec(), 0),
      this.safeQuery(checks, 'redemptions.total', () => this.redemptionModel.countDocuments({}).exec(), 0),
      this.safeQuery(checks, 'redemptions.reserved', () => this.redemptionModel.countDocuments({ status: PromoRedemptionStatus.RESERVED }).exec(), 0),
      this.safeQuery(checks, 'redemptions.redeemed', () => this.redemptionModel.countDocuments({ status: PromoRedemptionStatus.REDEEMED }).exec(), 0),
      this.safeQuery(checks, 'redemptions.released', () => this.redemptionModel.countDocuments({ status: PromoRedemptionStatus.RELEASED }).exec(), 0),
      this.safeQuery(checks, 'claims.total', () => this.claimModel.countDocuments({}).exec(), 0),
      this.safeQuery(checks, 'claims.active', () => this.claimModel.countDocuments({ status: PromoClaimStatus.ACTIVE }).exec(), 0),
      this.safeQuery(checks, 'claims.used', () => this.claimModel.countDocuments({ status: PromoClaimStatus.USED }).exec(), 0),
      this.safeQuery(checks, 'claims.expired', () => this.claimModel.countDocuments({ status: PromoClaimStatus.EXPIRED }).exec(), 0),
      this.safeQuery(checks, 'redemptions.stale-reserved', () => this.redemptionModel.countDocuments({ status: PromoRedemptionStatus.RESERVED, createdAt: { $lt: dayAgo } }).exec(), 0),
    ]);

    const warnings: string[] = [];
    if (!databaseReady) warnings.push('MongoDB connection is not ready.');
    if (expiredActive > 0) warnings.push(`${expiredActive} expired promo campaign(s) are still marked active.`);
    if (staleReservations > 0) warnings.push(`${staleReservations} redemption reservation(s) are older than 24 hours and remain reserved.`);
    if (pendingRewards + approvedRewards > 0) warnings.push(`${pendingRewards + approvedRewards} reward(s) are not yet marked paid.`);
    if (checks.some((check) => check.status === 'FAILED')) warnings.push('One or more monitoring queries failed.');

    const overview = {
      module: 'promos',
      checkedAt,
      status: !databaseReady || warnings.length ? 'DEGRADED' : 'OK',
      database: { connected: databaseReady, readyState: this.promoModel.db.readyState },
      metrics: {
        campaigns: { total: totalPromos, active: activePromos, running: currentlyRunning, upcomingActive, expiredButActive: expiredActive },
        rewards: { total: totalRewards, pending: pendingRewards, approved: approvedRewards, paid: paidRewards, createdLast24Hours: rewardsLast24Hours },
        participants: { total: participants },
        redemptions: { total: totalRedemptions, reserved: reservedRedemptions, redeemed: redeemedRedemptions, released: releasedRedemptions, staleReservedOver24Hours: staleReservations },
        claims: { total: totalClaims, active: activeClaims, used: usedClaims, expired: expiredClaims },
      },
      checks,
      warnings,
    };
    this.systemMonitor.reportMonitorSnapshot('promos', {
      status: overview.status,
      checkedAt,
      checks,
      warnings,
      details: {
        databaseConnected: databaseReady,
        activeCampaigns: activePromos,
        expiredActiveCampaigns: expiredActive,
        staleReservations,
        unpaidRewards: pendingRewards + approvedRewards,
      },
    });
    return overview;
  }
}
