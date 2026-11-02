import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model } from 'mongoose';
import { BET_LAB_CONFIG, BetLabPlan } from '../config/bet-lab.config';
import { UpdateBetLabVirtualPointsSettingsDto } from '../dto/update-bet-lab-virtual-points-settings.dto';
import { BetLabEventCategory, BetLabEventLevel } from '../enums/bet-lab-event.enum';
import { BetLabSettings } from '../schemas/bet-lab-settings.schema';
import { BetLabEventService } from './bet-lab-event.service';

const SETTINGS_KEY = 'virtual-points';

export interface BetLabVirtualPointsSettings {
  registrationBonus: number;
  monthlyAllowanceByPlan: Record<BetLabPlan, number>;
  updatedBy?: string;
  updatedAt?: Date;
}

@Injectable()
export class BetLabSettingsService {
  constructor(
    @InjectModel(BetLabSettings.name)
    private readonly settingsModel: Model<BetLabSettings>,
    private readonly events: BetLabEventService,
  ) {}

  async getVirtualPointsSettings(
    session?: ClientSession,
  ): Promise<BetLabVirtualPointsSettings> {
    let query = this.settingsModel.findOne({ key: SETTINGS_KEY });
    if (session) query = query.session(session);

    const saved = await query.lean().exec();
    if (!saved) return this.defaults();

    return {
      registrationBonus: Number(saved.registrationBonus),
      monthlyAllowanceByPlan: this.normalizeAllowances(saved.monthlyAllowanceByPlan),
      ...(saved.updatedBy ? { updatedBy: saved.updatedBy } : {}),
      ...(saved.updatedAt ? { updatedAt: saved.updatedAt } : {}),
    };
  }

  async updateVirtualPointsSettings(
    input: UpdateBetLabVirtualPointsSettingsDto,
    adminId: string,
  ): Promise<BetLabVirtualPointsSettings> {
    const previous = await this.getVirtualPointsSettings();
    const registrationBonus = Number(input.registrationBonus);
    const monthlyAllowanceByPlan = this.normalizeAllowances(input.monthlyAllowanceByPlan);

    const saved = await this.settingsModel.findOneAndUpdate(
      { key: SETTINGS_KEY },
      {
        $set: {
          registrationBonus,
          monthlyAllowanceByPlan,
          updatedBy: adminId,
        },
        $setOnInsert: { key: SETTINGS_KEY },
      },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
    ).lean().exec();

    const updated: BetLabVirtualPointsSettings = {
      registrationBonus: Number(saved?.registrationBonus ?? registrationBonus),
      monthlyAllowanceByPlan: this.normalizeAllowances(
        saved?.monthlyAllowanceByPlan ?? monthlyAllowanceByPlan,
      ),
      ...(saved?.updatedBy ? { updatedBy: saved.updatedBy } : {}),
      ...(saved?.updatedAt ? { updatedAt: saved.updatedAt } : {}),
    };

    await this.events.record({
      level: BetLabEventLevel.INFO,
      category: BetLabEventCategory.ADMIN,
      action: 'VIRTUAL_POINTS_SETTINGS_UPDATED',
      message: 'Bet Lab welcome bonus and monthly allowances were updated by an administrator.',
      userId: adminId,
      metadata: {
        previous: {
          registrationBonus: previous.registrationBonus,
          monthlyAllowanceByPlan: previous.monthlyAllowanceByPlan,
        },
        updated: {
          registrationBonus: updated.registrationBonus,
          monthlyAllowanceByPlan: updated.monthlyAllowanceByPlan,
        },
      },
    });

    return updated;
  }

  private defaults(): BetLabVirtualPointsSettings {
    return {
      registrationBonus: BET_LAB_CONFIG.virtualPoints.registrationBonus,
      monthlyAllowanceByPlan: {
        ...BET_LAB_CONFIG.virtualPoints.monthlyAllowanceByPlan,
      },
    };
  }

  private normalizeAllowances(value: unknown): Record<BetLabPlan, number> {
    const source = value && typeof value === 'object'
      ? value as Record<string, unknown>
      : {};
    const defaults = BET_LAB_CONFIG.virtualPoints.monthlyAllowanceByPlan;

    return {
      free: this.safeAmount(source.free, defaults.free),
      regular: this.safeAmount(source.regular, defaults.regular),
      vip: this.safeAmount(source.vip, defaults.vip),
      premium: this.safeAmount(source.premium, defaults.premium),
    };
  }

  private safeAmount(value: unknown, fallback: number): number {
    const amount = Number(value);
    return Number.isSafeInteger(amount) && amount >= 0 ? amount : fallback;
  }
}
