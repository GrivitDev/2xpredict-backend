import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { User, UserStatus } from './schemas/user.schema';

const LOGIN_FAILURE_LIMIT = 8;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const PASSWORD_RESET_FAILURE_LIMIT = 5;
const PASSWORD_RESET_LOCK_MS = 15 * 60 * 1000;

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name)
    private userModel: Model<User>,
  ) {}

  async findAll(query: any) {
    const rawSearch = typeof query.search === 'string' ? query.search.trim().slice(0, 100) : '';
    const search = rawSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const requestedPage = Number(query.page);
    const requestedLimit = Number(query.limit);
    const page = Number.isFinite(requestedPage) ? Math.max(1, Math.floor(requestedPage)) : 1;
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(100, Math.floor(requestedLimit))) : 20;
    const skip = (page - 1) * limit;

    // Admin user management includes unverified registrations so they can be
    // helped with email verification and can receive administrative bonuses.
    const filter: any = {
      isDeleted: false,
    };

    if (search) {
      filter.$or = [
        {
          email: {
            $regex: search,
            $options: 'i',
          },
        },
        {
          fullName: {
            $regex: search,
            $options: 'i',
          },
        },
        {
          username: {
            $regex: search,
            $options: 'i',
          },
        },
      ];
    }

    if (query.status && query.status !== 'all') {
      filter.status = query.status;
    }

    if (query.role && query.role !== 'all') {
      filter.role = query.role;
    }

    if (Array.isArray(query.includeUserIds)) {
      filter._id = { ...(filter._id ?? {}), $in: query.includeUserIds };
    }
    if (Array.isArray(query.excludeUserIds) && query.excludeUserIds.length) {
      filter._id = { ...(filter._id ?? {}), $nin: query.excludeUserIds };
    }

    if (typeof query.isVerified === 'boolean') {
      filter.isVerified = query.isVerified;
    }

    const createdAt: Record<string, Date> = {};
    if (query.createdFrom) {
      const from = new Date(query.createdFrom);
      if (Number.isFinite(from.getTime())) createdAt.$gte = from;
    }
    if (query.createdTo) {
      const to = new Date(query.createdTo);
      if (Number.isFinite(to.getTime())) {
        to.setHours(23, 59, 59, 999);
        createdAt.$lte = to;
      }
    }
    if (Object.keys(createdAt).length) filter.createdAt = createdAt;

    const [users, total] = await Promise.all([
      this.userModel
        .find(filter)
        .select('-passwordResetToken -passwordResetExpires')
        .skip(skip)
        .limit(limit)
        .sort({ createdAt: -1 })
        .lean()
        .exec(),

      this.userModel.countDocuments(filter).exec(),
    ]);

    return {
      users,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  // =========================
  // FINDERS
  // =========================
  async findByEmail(email: string) {
    return this.userModel
      .findOne({
        email: email.trim().toLowerCase(),
        isDeleted: false,
      })
      .select('-passwordResetToken -passwordResetExpires -passwordResetAttempts -passwordResetLockedUntil')
      .exec();
  }

  async findByUsername(username: string) {
    return this.userModel.findOne({
      username: username.trim().toLowerCase(),
      isDeleted: false,
    });
  }

  async findByEmailWithPassword(email: string) {
    return this.userModel
      .findOne({
        email: email.trim().toLowerCase(),
        isDeleted: false,
      })
      .select('+password +authVersion +loginFailedAttempts +loginLockedUntil -passwordResetToken -passwordResetExpires -passwordResetAttempts -passwordResetLockedUntil')
      .exec();
  }

  async findByEmailForPasswordReset(email: string) {
    return this.userModel
      .findOne({
        email: email.trim().toLowerCase(),
        isDeleted: false,
      })
      .select('+passwordResetToken +passwordResetExpires +passwordResetRequestedAt +passwordResetAttempts +passwordResetLockedUntil')
      .exec();
  }

  /**
   * Atomically claims the per-account password-reset cooldown and replaces the
   * outstanding token. Concurrent requests from different IP addresses cannot
   * overwrite one another's reset token during the cooldown window.
   */
  async claimPasswordResetRequest(
    email: string,
    tokenHash: string,
    expiresAt: Date,
    requestedAt: Date,
    cooldownCutoff: Date,
  ) {
    return this.userModel.findOneAndUpdate(
      {
        email: email.trim().toLowerCase(),
        isDeleted: false,
        $and: [
          {
            $or: [
              { passwordResetRequestedAt: { $exists: false } },
              { passwordResetRequestedAt: null },
              { passwordResetRequestedAt: { $lte: cooldownCutoff } },
            ],
          },
          {
            $or: [
              { passwordResetLockedUntil: { $exists: false } },
              { passwordResetLockedUntil: null },
              { passwordResetLockedUntil: { $lte: requestedAt } },
            ],
          },
        ],
      },
      {
        $set: {
          passwordResetToken: tokenHash,
          passwordResetExpires: expiresAt,
          passwordResetRequestedAt: requestedAt,
          passwordResetAttempts: 0,
        },
        $unset: { passwordResetLockedUntil: 1 },
      },
      { returnDocument: 'after' },
    ).exec();
  }

  async findById(userId: string) {
    if (!Types.ObjectId.isValid(userId)) return null;
    return this.userModel
      .findOne({ _id: userId, isDeleted: false })
      .select('-passwordResetToken -passwordResetExpires -passwordResetAttempts -passwordResetLockedUntil -passwordResetRequestedAt')
      .exec();
  }

  /** Authentication-only lookup; keeps the internal token version out of API profile responses. */
  async findByIdForAuth(userId: string) {
    if (!Types.ObjectId.isValid(userId)) return null;
    return this.userModel
      .findOne({ _id: userId, isDeleted: false })
      .select('+authVersion -passwordResetToken -passwordResetExpires -passwordResetAttempts -passwordResetLockedUntil -passwordResetRequestedAt')
      .exec();
  }

  /** OTP-only lookup for the internal first-verification recovery flag. */
  async findByIdForVerification(userId: string) {
    if (!Types.ObjectId.isValid(userId)) return null;
    return this.userModel
      .findOne({ _id: userId, isDeleted: false })
      .select('+verificationOnboardingPending -passwordResetToken -passwordResetExpires -passwordResetAttempts -passwordResetLockedUntil -passwordResetRequestedAt')
      .exec();
  }

  async findByIdWithPassword(userId: string) {
    return this.userModel
      .findOne({ _id: userId, isDeleted: false })
      .select('+password -passwordResetToken -passwordResetExpires -passwordResetAttempts -passwordResetLockedUntil -passwordResetRequestedAt')
      .exec();
  }

  /** Changes email only after the caller has verified the current and new addresses. */
  async changeEmailAndVerify(
    userId: string,
    email: string,
    firstVerification = false,
  ) {
    return this.userModel.findOneAndUpdate(
      { _id: userId, isDeleted: false },
      {
        $set: {
          email: email.trim().toLowerCase(),
          isVerified: true,
          status: UserStatus.ACTIVE,
          ...(firstVerification ? { verificationOnboardingPending: true } : {}),
        },
        $unset: { verificationExpiresAt: 1 },
      },
      { returnDocument: 'after', runValidators: true },
    ).select('+verificationOnboardingPending').exec();
  }

  async clearPendingPromoCode(userId: string) {
    await this.userModel.updateOne(
      { _id: userId, isDeleted: false },
      { $unset: { pendingPromoCode: 1 } },
    ).exec();
  }

  async completeVerificationOnboarding(userId: string) {
    return this.userModel.updateOne(
      { _id: userId, isDeleted: false, verificationOnboardingPending: true },
      { $set: { verificationOnboardingPending: false } },
    ).exec();
  }

  /** Recipient selection intentionally includes active and pending accounts, including unverified users. */
  async countBonusRecipients(): Promise<number> {
    return this.userModel.countDocuments({ isDeleted: false }).exec();
  }

  async getLastBonusRecipientId(): Promise<string | null> {
    const user = await this.userModel
      .findOne({ isDeleted: false })
      .sort({ _id: -1 })
      .select({ _id: 1 })
      .lean()
      .exec();
    return user?._id ? String(user._id) : null;
  }

  async getBonusRecipientIds(
    afterId: string | null | undefined,
    throughId: string | null | undefined,
    limit = 25,
  ): Promise<string[]> {
    // Includes pending/unverified and suspended accounts, but never soft-deleted users.
    const filter: Record<string, unknown> = { isDeleted: false };
    const idRange: Record<string, Types.ObjectId> = {};
    if (afterId && Types.ObjectId.isValid(afterId)) idRange.$gt = new Types.ObjectId(afterId);
    if (throughId && Types.ObjectId.isValid(throughId)) idRange.$lte = new Types.ObjectId(throughId);
    if (Object.keys(idRange).length) filter._id = idRange;
    const docs = await this.userModel
      .find(filter)
      .select({ _id: 1 })
      .sort({ _id: 1 })
      .limit(Math.max(1, Math.min(100, Math.floor(limit))))
      .lean()
      .exec();
    return docs.map((doc) => String(doc._id));
  }

  // =========================
  // CREATE USER
  // =========================
  async create(userData: Partial<User>) {
    const user = new this.userModel({
      ...userData,
      email: userData.email?.trim().toLowerCase(),
      username: userData.username?.trim().toLowerCase(),
      status: UserStatus.PENDING,
    });

    return user.save();
  }

  // =========================
  // VERIFICATION
  // =========================
  async verifyUser(email: string) {
    const normalizedEmail = email.trim().toLowerCase();
    const updated = await this.userModel.findOneAndUpdate(
      {
        email: normalizedEmail,
        isDeleted: false,
        isVerified: false,
      },
      {
        $set: {
          isVerified: true,
          status: UserStatus.ACTIVE,
          verificationOnboardingPending: true,
        },
        // Keep pendingPromoCode until referral/promo onboarding side effects
        // finish; the OTP workflow clears it after successful completion.
        $unset: {
          verificationExpiresAt: 1,
        },
      },
      { returnDocument: 'after' },
    ).select('+verificationOnboardingPending').exec();

    // Returning the already-verified account allows a claimed OTP workflow to
    // resume safely when a process stopped after the account update.
    if (updated) return updated;
    return this.userModel.findOne({
      email: normalizedEmail,
      isDeleted: false,
      isVerified: true,
    }).select('+verificationOnboardingPending').exec();
  }

  // =========================
  // REFERRAL TRACKING
  // =========================

  async incrementSuccessfulReferrals(
    userId: string,
    session?: ClientSession,
  ) {
    const query = this.userModel.findOneAndUpdate(
      { _id: userId, isDeleted: false },
      { $inc: { successfulReferrals: 1 } },
      { returnDocument: 'after' },
    );
    if (session) query.session(session);
    return query.exec();
  }
  // =========================
  // ADMIN CONTROL
  // =========================

  async suspendUser(
    userId: string,
    data: { reason?: string; bannedUntil?: Date },
    adminId: string,
  ) {
    if (data.bannedUntil && data.bannedUntil.getTime() <= Date.now()) {
      throw new BadRequestException('The suspension end date must be in the future.');
    }
    const update: Record<string, any> = {
      $set: {
        status: UserStatus.SUSPENDED,
        banReason: data.reason?.trim() || 'Suspended by administrator',
        bannedBy: adminId,
        ...(data.bannedUntil ? { bannedUntil: data.bannedUntil } : {}),
      },
      ...(!data.bannedUntil ? { $unset: { bannedUntil: 1 } } : {}),
    };
    return this.userModel.findOneAndUpdate(
      { _id: userId, isDeleted: false },
      update,
      { returnDocument: 'after' },
    );
  }

  async activateUser(userId: string) {
    return this.userModel.findByIdAndUpdate(
      userId,
      {
        $set: {
          status: UserStatus.ACTIVE,
        },
        $unset: {
          banReason: 1,
          bannedUntil: 1,
          bannedBy: 1,
        },
      },
      { returnDocument: 'after' },
    );
  }

  async softDeleteUser(userId: string, adminId?: string) {
    return this.userModel.findOneAndUpdate(
      { _id: userId, isDeleted: false },
      {
        $set: {
          status: UserStatus.DELETED,
          isDeleted: true,
          deletedAt: new Date(),
          deletedBy: adminId,
        },
      },
      { returnDocument: 'after' },
    );
  }

  // =========================
  // LOGIN TRACKING
  // =========================
  async recordLoginFailure(userId: string) {
    const now = new Date();
    const lockUntil = new Date(now.getTime() + LOGIN_LOCK_MS);
    const lockExpired = {
      $and: [
        { $ne: [{ $ifNull: ['$loginLockedUntil', null] }, null] },
        { $lte: ['$loginLockedUntil', now] },
      ],
    };
    const attemptsExpression = {
      $cond: [
        lockExpired,
        1,
        { $add: [{ $ifNull: ['$loginFailedAttempts', 0] }, 1] },
      ],
    };

    return this.userModel.findOneAndUpdate(
      { _id: userId, isDeleted: false },
      [
        { $set: { loginFailedAttempts: attemptsExpression } },
        {
          $set: {
            loginLockedUntil: {
              $cond: [
                { $gte: ['$loginFailedAttempts', LOGIN_FAILURE_LIMIT] },
                lockUntil,
                { $cond: [lockExpired, null, '$loginLockedUntil'] },
              ],
            },
          },
        },
      ] as any,
      { returnDocument: 'after' },
    ).exec();
  }

  async updateLoginInfo(
    userId: string,
    expectedAuthVersion: number,
    expectedPasswordHash: string,
  ) {
    const versionConditions =
      expectedAuthVersion === 0
        ? [{ authVersion: 0 }, { authVersion: { $exists: false } }]
        : [{ authVersion: expectedAuthVersion }];

    return this.userModel.findOneAndUpdate(
      {
        _id: userId,
        isDeleted: false,
        password: expectedPasswordHash,
        $or: versionConditions,
      },
      {
        $set: {
          lastLoginAt: new Date(),
          loginFailedAttempts: 0,
          authVersion: expectedAuthVersion,
        },
        $unset: { loginLockedUntil: 1 },
        $inc: { loginCount: 1 },
      },
      { returnDocument: 'after' },
    ).exec();
  }

  async recordPasswordResetFailure(userId: string, expectedTokenHash: string) {
    const now = new Date();
    const lockUntil = new Date(now.getTime() + PASSWORD_RESET_LOCK_MS);
    const lockExpired = {
      $and: [
        { $ne: [{ $ifNull: ['$passwordResetLockedUntil', null] }, null] },
        { $lte: ['$passwordResetLockedUntil', now] },
      ],
    };
    const attemptsExpression = {
      $cond: [
        lockExpired,
        1,
        { $add: [{ $ifNull: ['$passwordResetAttempts', 0] }, 1] },
      ],
    };

    return this.userModel.findOneAndUpdate(
      { _id: userId, passwordResetToken: expectedTokenHash, isDeleted: false },
      [
        { $set: { passwordResetAttempts: attemptsExpression } },
        {
          $set: {
            passwordResetLockedUntil: {
              $cond: [
                { $gte: ['$passwordResetAttempts', PASSWORD_RESET_FAILURE_LIMIT] },
                lockUntil,
                { $cond: [lockExpired, null, '$passwordResetLockedUntil'] },
              ],
            },
          },
        },
      ] as any,
      { returnDocument: 'after' },
    ).exec();
  }

  async consumePasswordResetToken(
    userId: string,
    expectedTokenHash: string,
    newPasswordHash: string,
    now: Date,
    session: ClientSession,
  ) {
    return this.userModel.findOneAndUpdate(
      {
        _id: userId,
        isDeleted: false,
        passwordResetToken: expectedTokenHash,
        passwordResetExpires: { $gt: now },
        $or: [
          { passwordResetLockedUntil: { $exists: false } },
          { passwordResetLockedUntil: null },
          { passwordResetLockedUntil: { $lte: now } },
        ],
      },
      {
        $set: {
          password: newPasswordHash,
          passwordResetAttempts: 0,
        },
        $inc: { authVersion: 1 },
        $unset: {
          passwordResetToken: 1,
          passwordResetExpires: 1,
          passwordResetLockedUntil: 1,
        },
      },
      { returnDocument: 'after', session },
    ).exec();
  }

  async updatePasswordIfCurrent(
    userId: string,
    expectedPasswordHash: string,
    newPasswordHash: string,
    session: ClientSession,
  ) {
    return this.userModel.findOneAndUpdate(
      {
        _id: userId,
        isDeleted: false,
        password: expectedPasswordHash,
      },
      {
        $set: { password: newPasswordHash },
        $inc: { authVersion: 1 },
      },
      { returnDocument: 'after', session },
    ).exec();
  }

  // =========================
  // ANALYTICS
  // =========================
  async countUsers() {
    return this.userModel.countDocuments({
      isDeleted: false,
      isVerified: true,
    });
  }

  async countActiveUsers() {
    return this.userModel.countDocuments({
      status: UserStatus.ACTIVE,
      isDeleted: false,
      isVerified: true,
    });
  }

  async countSuspendedUsers() {
    return this.userModel.countDocuments({
      status: UserStatus.SUSPENDED,
      isDeleted: false,
      isVerified: true,
    });
  }

  async getRecentUsers(limit: number = 10) {
    return this.userModel
      .find({
        isDeleted: false,
        isVerified: true,
      })
      .sort({ createdAt: -1 })
      .limit(limit);
  }

  async getNewUsersToday() {
    const start = new Date();
    start.setHours(0, 0, 0, 0);

    return this.userModel.countDocuments({
      createdAt: { $gte: start },
      isDeleted: false,
      isVerified: true,
    });
  }

  async updateProfile(
    userId: string,
    data: {
      fullName?: string;
      username?: string;
      phoneNumber?: string;
    },
  ) {
    return this.userModel.findByIdAndUpdate(
      userId,
      {
        $set: {
          ...(data.fullName && {
            fullName: data.fullName,
          }),

          ...(data.username && {
            username: data.username.toLowerCase(),
          }),

          ...(data.phoneNumber && {
            phoneNumber: data.phoneNumber,
          }),
        },
      },
      { returnDocument: 'after' },
    );
  }
}
