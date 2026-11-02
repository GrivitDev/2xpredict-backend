import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, UpdateQuery } from 'mongoose';
import { SupportRateLimit } from '../schemas/support-rate-limit.schema';

const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 8;
const LIMIT_RECORD_TTL_MS = 2 * 60_000;

@Injectable()
export class SupportRateLimitService {
  constructor(
    @InjectModel(SupportRateLimit.name)
    private readonly limits: Model<SupportRateLimit>,
  ) {}

  /**
   * Atomically consumes one slot in a rolling 60-second window across all app
   * instances. The pipeline filters timestamps and increments within one MongoDB
   * findAndModify operation, avoiding the previous count-then-insert race.
   */
  async consume(userId: string): Promise<void> {
    if (!Types.ObjectId.isValid(userId)) {
      throw new HttpException(
        'Authenticated user ID is invalid.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const now = new Date();
    const cutoff = new Date(now.getTime() - WINDOW_MS);
    const expiresAt = new Date(now.getTime() + LIMIT_RECORD_TTL_MS);
    const owner = new Types.ObjectId(userId);

    // Ensure the one-per-user counter exists. Simultaneous first requests may race
    // to insert; the unique userId index makes one win and E11000 is safe here.
    try {
      await this.limits
        .updateOne(
          { userId: owner },
          { $setOnInsert: { userId: owner, requestTimes: [], expiresAt } },
          { upsert: true },
        )
        .exec();
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    }

    const recentTimes = {
      $filter: {
        input: { $ifNull: ['$requestTimes', []] },
        as: 'requestAt',
        cond: { $gt: ['$$requestAt', cutoff] },
      },
    };
    const updated = await this.limits
      .findOneAndUpdate(
        {
          userId: owner,
          $expr: { $lt: [{ $size: recentTimes }, MAX_REQUESTS_PER_WINDOW] },
        },
        [
          {
            $set: {
              requestTimes: { $concatArrays: [recentTimes, [now]] },
              expiresAt,
              updatedAt: now,
            },
          },
        ] as unknown as UpdateQuery<SupportRateLimit>,
        {
          returnDocument: 'after',
          updatePipeline: true,
        },
      )
      .lean()
      .exec();

    if (!updated) {
      throw new HttpException(
        'Please wait a moment before sending another support message.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 11000
  );
}
