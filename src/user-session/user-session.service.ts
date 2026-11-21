import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import {
  UserSession,
  UserSessionDocument,
} from './schemas/user-session.schema';
import { parseDevice } from '../common/utils/device-parser';
import { GeoLocationService } from '../common/services/geo-location.service';

@Injectable()
export class UserSessionService {
  constructor(
    @InjectModel(UserSession.name)
    private sessionModel: Model<UserSession>,
    private geoLocationService: GeoLocationService,
  ) {}

  async createSession(
    data: Partial<UserSession>,
  ): Promise<UserSessionDocument> {
    const location = data.ipAddress
      ? ((await this.geoLocationService.lookup(data.ipAddress)) ?? undefined)
      : undefined;

    const session = await this.sessionModel.create({
      ...data,
      location,
      device: data.userAgent ? parseDevice(data.userAgent) : 'Unknown Device',
      lastActiveAt: new Date(),
      isActive: true,
    });

    return session;
  }

  async findSessionById(sessionId: string) {
    const session = await this.sessionModel.findById(sessionId);

    if (!session) {
      return null;
    }

    if (
      session.isActive &&
      session.expiresAt &&
      session.expiresAt <= new Date()
    ) {
      await this.sessionModel.findByIdAndUpdate(sessionId, {
        $set: {
          isActive: false,
        },
      });

      session.isActive = false;
    }

    return session;
  }

  async revokeSession(sessionId: string, userId?: string) {
    return this.sessionModel.findOneAndUpdate(
      {
        _id: sessionId,
        ...(userId ? { userId: new Types.ObjectId(userId) } : {}),
        isActive: true,
      },
      {
        $set: {
          isActive: false,
        },
      },
    );
  }

  async deactivateAllUserSessions(userId: string, session?: ClientSession) {
    const update = this.sessionModel.updateMany(
      {
        userId: new Types.ObjectId(userId),
        isActive: true,
      },
      {
        $set: {
          isActive: false,
        },
      },
    );

    if (session) update.session(session);
    await update.exec();
  }

  async updateActivity(sessionId: string) {
    // Avoid writing lastActiveAt on every authenticated request. Security checks
    // still validate activity/expiry on reads; persistence is throttled to once
    // per minute per session.
    const now = new Date();
    const writeAfter = new Date(now.getTime() - 60_000);
    return this.sessionModel.updateOne(
      {
        _id: sessionId,
        isActive: true,
        expiresAt: { $gt: now },
        lastActiveAt: { $lte: writeAfter },
      },
      { $set: { lastActiveAt: now } },
    ).exec();
  }

  // =====================================
  // ADMIN SUMMARY
  // =====================================
  /**
   * Builds the admin profile session summary in one database round trip.
   *
   * The latest-session list remains the same latest 10 records. To preserve the
   * existing currentSession behaviour, the active candidate is still selected
   * from the latest 100 records, just as getUserSessions() did previously.
   * Counts are calculated over the complete per-user record set.
   */
  async getSessionSummary(userId: string) {
    const userObjectId = new Types.ObjectId(userId);
    const now = new Date();

    const [summary] = await this.sessionModel
      .aggregate([
        { $match: { userId: userObjectId } },
        { $sort: { lastActiveAt: -1 } },
        {
          $facet: {
            latestSessions: [{ $limit: 10 }],
            currentSession: [
              { $limit: 100 },
              {
                $match: {
                  isActive: true,
                  expiresAt: { $gt: now },
                },
              },
              { $limit: 1 },
            ],
            totalSessions: [{ $count: 'count' }],
            activeSessions: [
              {
                $match: {
                  isActive: true,
                  expiresAt: { $gt: now },
                },
              },
              { $count: 'count' },
            ],
          },
        },
      ])
      .exec();

    const latestSessions = Array.isArray(summary?.latestSessions)
      ? summary.latestSessions
      : [];
    const currentSessionRecord = Array.isArray(summary?.currentSession)
      ? summary.currentSession[0] ?? null
      : null;
    const totalSessions = Number(summary?.totalSessions?.[0]?.count ?? 0);
    const activeSessions = Number(summary?.activeSessions?.[0]?.count ?? 0);

    const withComputedState = (session: Record<string, any>) => ({
      ...session,
      isActive: Boolean(session.isActive && session.expiresAt > now),
      expired: session.expiresAt <= now,
    });

    return {
      latestSessions: latestSessions.map(withComputedState),
      totalSessions,
      activeSessions,
      lastLogin: latestSessions.length ? latestSessions[0].lastActiveAt : null,
      currentSession: currentSessionRecord
        ? withComputedState(currentSessionRecord)
        : null,
    };
  }

  async getUserSessions(userId: string) {
    const now = new Date();

    const sessions = await this.sessionModel
      .find({
        userId: new Types.ObjectId(userId),
      })
      .sort({ lastActiveAt: -1 })
      .limit(100);

    return sessions.map((session) => ({
      ...session.toObject(),
      isActive: session.isActive && session.expiresAt > now,
      expired: session.expiresAt <= now,
    }));
  }

  async cleanupUserSessions(userId: string) {
    return this.sessionModel.updateMany(
      {
        userId,
        expiresAt: {
          $lte: new Date(),
        },
        isActive: true,
      },
      {
        $set: {
          isActive: false,
        },
      },
    );
  }
}
