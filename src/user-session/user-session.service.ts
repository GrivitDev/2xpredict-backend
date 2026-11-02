import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
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

  async deactivateAllUserSessions(userId: string) {
    await this.sessionModel.updateMany(
      {
        userId,
        isActive: true,
      },
      {
        $set: {
          isActive: false,
        },
      },
    );
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
  async getSessionSummary(userId: string) {
    const userObjectId = new Types.ObjectId(userId);
    const now = new Date();
    const [sessions, totalSessions, activeSessions] = await Promise.all([
      this.getUserSessions(userId),
      this.sessionModel.countDocuments({ userId: userObjectId }).exec(),
      this.sessionModel.countDocuments({ userId: userObjectId, isActive: true, expiresAt: { $gt: now } }).exec(),
    ]);
    const currentSession = sessions.find((session) => session.isActive && session.expiresAt > now) ?? null;
    return {
      latestSessions: sessions.slice(0, 10),
      totalSessions,
      activeSessions,
      lastLogin: sessions.length ? sessions[0].lastActiveAt : null,
      currentSession,
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

