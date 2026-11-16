import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { InternalAd, InternalAdDocument } from './schemas/internal-ad.schema';
import { CreateInternalAdDto } from './dto/create-internal-ad.dto';
import { UpdateInternalAdDto } from './dto/update-internal-ad.dto';
import { InternalAdPlacement } from './enums/internal-ad-placement.enum';

@Injectable()
export class InternalAdsService {
  constructor(
    @InjectModel(InternalAd.name)
    private readonly internalAdModel: Model<InternalAdDocument>,
  ) {}

  async create(createAdDto: CreateInternalAdDto) {
    return this.internalAdModel.create({
      ...createAdDto,
      // Existing clients do not send placements. Preserve their current web-ad behaviour.
      placements: createAdDto.placements?.length
        ? createAdDto.placements
        : [InternalAdPlacement.WEB],
    });
  }

  async update(id: string, updateAdDto: UpdateInternalAdDto) {
    const update = { ...updateAdDto };
    if (update.placements && update.placements.length === 0) {
      update.placements = [InternalAdPlacement.WEB];
    }
    const ad = await this.internalAdModel.findByIdAndUpdate(id, update, {
      returnDocument: 'after',
      runValidators: true,
    });
    if (!ad) throw new NotFoundException('Ad not found');
    return ad;
  }

  async remove(id: string) {
    const ad = await this.internalAdModel.findByIdAndDelete(id);
    if (!ad) throw new NotFoundException('Ad not found');
    return { message: 'Ad deleted successfully' };
  }

  async findOne(id: string) {
    const ad = await this.internalAdModel.findById(id);
    if (!ad) throw new NotFoundException('Ad not found');
    return ad;
  }

  async findAll() {
    return this.internalAdModel.find().sort({ sortOrder: -1, createdAt: -1 });
  }

  /** Active ads intended for existing web placements. Legacy records remain web-visible. */
  async getActiveAds() {
    const now = new Date();
    return this.internalAdModel
      .find({
        isActive: true,
        startDate: { $lte: now },
        endDate: { $gte: now },
        $or: [
          { placements: InternalAdPlacement.WEB },
          { placements: { $exists: false } },
          { placements: { $size: 0 } },
        ],
      })
      .sort({ sortOrder: -1, createdAt: -1 });
  }

  /** Active Telegram campaigns, ordered so least-recently-used ads rotate first. */
  async getActiveTelegramAds() {
    const now = new Date();
    return this.internalAdModel
      .find({
        isActive: true,
        startDate: { $lte: now },
        endDate: { $gte: now },
        placements: InternalAdPlacement.TELEGRAM,
      })
      .sort({ lastTelegramSentAt: 1, sortOrder: -1, createdAt: 1 })
      .exec();
  }

  async recordTelegramDelivery(
    id: string,
    sentAt: Date,
    messageId?: number,
  ): Promise<void> {
    const result = await this.internalAdModel.updateOne(
      { _id: id, isActive: true, placements: InternalAdPlacement.TELEGRAM },
      {
        $set: {
          lastTelegramSentAt: sentAt,
          ...(typeof messageId === 'number' ? { lastTelegramMessageId: messageId } : {}),
        },
      },
    ).exec();
    if (result.matchedCount === 0) {
      throw new NotFoundException('Telegram internal ad disappeared before delivery could be recorded.');
    }
  }
}
