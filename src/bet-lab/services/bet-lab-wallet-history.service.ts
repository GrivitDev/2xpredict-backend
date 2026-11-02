import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BET_LAB_CONFIG } from '../config/bet-lab.config';
import { BetLabWalletLedger } from '../schemas/bet-lab-wallet-ledger.schema';

@Injectable()
export class BetLabWalletHistoryService {
  constructor(
    @InjectModel(BetLabWalletLedger.name)
    private readonly ledgerModel: Model<BetLabWalletLedger>,
  ) {}

  async list(userId: string, pageValue?: number, limitValue?: number) {
    const page = Math.max(1, Math.floor(Number(pageValue) || 1));
    const limit = Math.min(
      BET_LAB_CONFIG.monitor.maximumHistoryPageSize,
      Math.max(
        1,
        Math.floor(
          Number(limitValue) || BET_LAB_CONFIG.monitor.defaultHistoryPageSize,
        ),
      ),
    );
    const filter = { userId };
    const [items, total] = await Promise.all([
      this.ledgerModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
      this.ledgerModel.countDocuments(filter).exec(),
    ]);
    return {
      items,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }
}
