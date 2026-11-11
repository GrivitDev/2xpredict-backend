import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt-auth.guard';
import { SubscriptionsMonitorService } from './subscriptions-monitor.service';
import { SubscriptionsService } from './subscriptions.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { GetUser } from '../common/decorators/get-user.decorator';
import { PlanConfigService } from '../plan-config/plan-config.service';
import { UsersService } from '../users/users.service';
import {
  getSubscriptionEntitlements,
  SubscriptionEntitlementPlan,
} from './config/subscription-entitlements.config';

type OptionalAuthRequest = {
  user?: {
    _id?: unknown;
    id?: unknown;
    userId?: unknown;
    sub?: unknown;
  } | null;
};

@Controller('subscriptions')
export class SubscriptionsController {
  constructor(
    private readonly service: SubscriptionsService,
    private readonly planConfigService: PlanConfigService,
    private readonly usersService: UsersService,
    private readonly monitor: SubscriptionsMonitorService,
  ) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Get('admin/monitor')
  getModuleMonitor() {
    return this.monitor.getOverview();
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  getMySubscription(@GetUser() user: { _id: string }) {
    return this.service.getActiveSubscription(user._id);
  }

  @UseGuards(JwtAuthGuard)
  @Get('status')
  async getStatus(@GetUser() user: { _id: string }) {
    const subscription = await this.service.getActiveSubscription(user._id);
    const plan = await this.service.getUserPlan(user._id);

    return {
      plan,
      subscription,
      entitlements: getSubscriptionEntitlements(plan),
    };
  }

  /** Public read for ad rendering; anonymous and Free users retain advertising. */
  @UseGuards(OptionalJwtAuthGuard)
  @Get('entitlements')
  async getEntitlements(@Req() request: OptionalAuthRequest) {
    const user = request?.user ?? null;
    const userId = [user?._id, user?.id, user?.userId, user?.sub]
      .map((candidate) => String(candidate ?? '').trim())
      .find((candidate) => candidate.length > 0 && candidate !== '[object Object]');
    const plan: SubscriptionEntitlementPlan = userId
      ? await this.service.getUserPlan(userId)
      : 'anonymous';

    return getSubscriptionEntitlements(plan);
  }

  @UseGuards(JwtAuthGuard)
  @Get('upgrade-price')
  async getUpgradePrice(@GetUser() user: { _id: string }) {
    const config = await this.planConfigService.get();
    const dbUser = await this.usersService.findById(user._id);

    if (!dbUser) {
      throw new Error('User not found');
    }

    const prices = {
      regular:
        dbUser.currency === 'USD'
          ? config.regularPriceUSD
          : config.regularPrice,
      vip: dbUser.currency === 'USD' ? config.vipPriceUSD : config.vipPrice,
      premium:
        dbUser.currency === 'USD'
          ? config.premiumPriceUSD
          : config.premiumPrice,
    };

    const [vipUpgrade, premiumUpgrade] = await Promise.all([
      this.service.calculatePlanUpgradePrice(
        user._id,
        prices,
        'vip',
        30,
        dbUser.currency,
      ),
      this.service.calculatePlanUpgradePrice(
        user._id,
        prices,
        'premium',
        30,
        dbUser.currency,
      ),
    ]);

    // Preserve the former top-level VIP quote fields while exposing both tiers.
    return {
      ...vipUpgrade,
      vipUpgrade,
      premiumUpgrade,
    };
  }
}
