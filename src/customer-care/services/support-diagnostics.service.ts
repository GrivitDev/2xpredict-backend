import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { SystemMonitorService } from '../../system-monitor/system-monitor.service';
import { SystemMonitorStorageService } from '../../system-monitor/system-monitor-storage.service';
import { SystemMonitorDatabaseTrackerService } from '../../system-monitor/system-monitor-database-tracker.service';

const USER_REFERENCE_FIELDS = [
  'userId',
  'user',
  'ownerId',
  'customerId',
  'accountId',
  'subscriberId',
  'createdBy',
  'updatedBy',
  'referrerId',
  'referredUserId',
  'receiverId',
  'authorId',
  'registeredBy',
  'targetUserId',
  'subjectUserId',
  'recipientId',
  'claimantId',
  'participantId',
  'memberId',
  'beneficiaryUserId',
  'linkedUserId',
  'invitedUserId',
  'relatedUserId',
  'user_id',
  'userID',
  'userObjectId',
  'user._id',
  'account._id',
  'customer._id',
];
const SEARCHABLE_FIELDS = [
  'name',
  'title',
  'description',
  'message',
  'status',
  'eventId',
  'fixtureId',
  'homeTeamName',
  'awayTeamName',
  'leagueName',
  'marketKey',
  'selectionName',
  'reference',
  'transactionReference',
  'predictionCode',
  'promoCode',
  'type',
  'operation',
  'source',
  'errorCode',
  'lastError',
];
const SECRET_FIELD =
  /(password|passwordreset|resettoken|verificationtoken|access.?token|refresh.?token|session.?token|session.?id|(^|[^a-z])token($|[^a-z])|(^|[^a-z])code($|[^a-z])|authorization|cookie|secret|apikey|privatekey|salt|passwordhash|(^|[^a-z])otp($|[^a-z])|otp.?code|verificationcode|emailchange(code|token)|email|phone(number)?|ipaddress|useragent|devicefingerprint|csrf|two.?factor|mfa|cvv|cvc|cardnumber|bankaccount|accountnumber|providerpayload|gatewaypayload|rawresponse|gateway.?response|provider.?response|proofpublicid|adminnote)/i;
const MAX_COLLECTIONS_PER_INSPECTION = 80;
const MAX_DOCUMENTS_TOTAL = 40;
const MAX_DOCUMENTS_PER_COLLECTION = 2;
const MAX_INSPECTION_RUNTIME_MS = 8_000;
const MAX_DIAGNOSTIC_QUERY_MS = 500;
const MAX_COLLECTION_QUERY_CONCURRENCY = 3;

const MODULE_PREFIXES: Record<string, string[]> = {
  accounts: ['users', 'otp', 'user_session', 'usersession', 'admin_user'],
  users: ['users', 'otp', 'user_session', 'usersession', 'admin_user'],
  'admin-users': ['admin_user'],
  auth: ['users', 'otp', 'user_session', 'usersession', 'admin_user'],
  payments: ['payment', 'payment_gateway', 'exchange_rate'],
  'payment-gateways': ['payment_gateway', 'exchange_rate', 'payment'],
  subscriptions: ['subscription', 'plan_config', 'planconfig'],
  'plan-config': ['plan_config', 'planconfig'],
  'predictions-engine': [
    'predictions_engine_',
    'curated_prediction',
    'pick_center',
    'slip_center',
    'market_prediction',
    'market_calibration',
  ],
  'prediction-access': ['prediction_access'],
  sports: [
    'sports_',
    'espn_',
    'football_data',
    'active_competition',
    'youtube_highlight',
    'odds_api_sport',
  ],
  odds: [
    'odds_',
    'fixture_odds',
    'sports_fixture_odds',
    'sports_odds',
    'sports_odds_api_sports',
  ],
  'bet-lab': ['bet_lab_'],
  settlement: ['settlement_'],
  promos: ['promo'],
  referrals: ['referral'],
  bonuses: ['bonus'],
  sessions: ['user_session'],
  analytics: ['analytics', 'website_analytics'],
  'website-analytics': ['analytics', 'website_analytics'],
  ads: ['ad_', 'ads', 'internal_ad', 'internalads', 'external_ad'],
  'internal-ads': ['internal_ad', 'internalads'],
  notifications: ['notification', 'email'],
  'user-session': ['user_session', 'usersession'],
  realtime: ['admin_realtime'],
  uploads: ['upload'],
  telegram: ['telegram'],
  'system-monitor': ['system_monitor', 'admin_realtime'],
  all: [],
};

export interface DiagnosticModuleResult {
  module: string;
  inspectedAt: string;
  collectionNames: string[];
  matchingRecords: Array<{
    collection: string;
    document: Record<string, unknown>;
  }>;
  warnings: string[];
  technicalSignals: Array<{
    code: string;
    severity: 'HIGH' | 'CRITICAL';
    summary: string;
    evidence: string[];
  }>;
}

@Injectable()
export class SupportDiagnosticsService {
  private readonly logger = new Logger(SupportDiagnosticsService.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly systemMonitor: SystemMonitorService,
    private readonly storageMonitor: SystemMonitorStorageService,
    private readonly databaseTracker: SystemMonitorDatabaseTrackerService,
  ) {}

  /**
   * Read-only inspection across the current database collections. The authenticated
   * user ID is supplied by the backend, never by Groq. Business records are never
   * mutated by this service. Output is bounded and secret-shaped fields are removed.
   */
  async inspectUserData(
    userId: string,
    moduleName = 'all',
    keywords = '',
  ): Promise<DiagnosticModuleResult> {
    if (!Types.ObjectId.isValid(userId))
      throw new Error('Authenticated user ID is invalid.');
    const normalizedModule = String(moduleName || 'all')
      .trim()
      .toLowerCase();
    if (
      !Object.prototype.hasOwnProperty.call(MODULE_PREFIXES, normalizedModule)
    ) {
      throw new Error('Unsupported diagnostic module.');
    }

    const db = this.connection.db;
    if (!db)
      throw new Error('MongoDB is not available for support diagnostics.');

    const startedAtMs = Date.now();
    const deadlineMs = startedAtMs + MAX_INSPECTION_RUNTIME_MS;
    const warnings: string[] = [];
    const listed = await db
      .listCollections(
        {},
        { nameOnly: true, maxTimeMS: MAX_DIAGNOSTIC_QUERY_MS },
      )
      .toArray();
    let names = listed.map((item) => String(item.name || '')).filter(Boolean);
    names = names.filter(
      (name) =>
        !name.toLowerCase().startsWith('customer_care_') &&
        !name.toLowerCase().startsWith('support_'),
    );

    if (normalizedModule !== 'all') {
      const prefixes = MODULE_PREFIXES[normalizedModule];
      names = names.filter((name) =>
        prefixes.some((prefix) => name.toLowerCase().startsWith(prefix)),
      );
    } else {
      const priority = [
        'users',
        'payments',
        'subscriptions',
        'otp',
        'otps',
        'user_sessions',
        'user_session',
        'plan_configs',
        'planconfig',
        'curated_predictions',
        'market_predictions',
        'prediction_slips',
        'bet_lab_tickets',
        'bet_lab_wallets',
        'bet_lab_wallet_ledgers',
        'promo_claims',
        'promo_rewards',
        'referrals',
        'bonuses',
      ];
      const rank = (name: string) => {
        const normalized = name.toLowerCase();
        const exact = priority.indexOf(normalized);
        if (exact >= 0) return exact;
        const prefix = priority.findIndex((item) =>
          normalized.startsWith(item),
        );
        return prefix >= 0 ? prefix : priority.length + 1;
      };
      names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    }

    // Keep each model call within a collection, document and wall-clock budget.
    const collectionNames = names.slice(0, MAX_COLLECTIONS_PER_INSPECTION);
    if (names.length > collectionNames.length) {
      warnings.push(
        `Inspection was bounded to ${MAX_COLLECTIONS_PER_INSPECTION} collections; ${names.length - collectionNames.length} additional collections were not queried in this pass.`,
      );
    }

    const user = await db.collection('users').findOne(
      { _id: new Types.ObjectId(userId) },
      {
        projection: {
          _id: 1,
          fullName: 1,
          username: 1,
          email: 1,
          status: 1,
          isVerified: 1,
          role: 1,
          currency: 1,
          country: 1,
          lastLoginAt: 1,
          loginCount: 1,
          createdAt: 1,
          updatedAt: 1,
        },
        maxTimeMS: MAX_DIAGNOSTIC_QUERY_MS,
      },
    );
    if (!user)
      warnings.push(
        'The authenticated user record was not found in the users collection.',
      );

    const userObjectId = new Types.ObjectId(userId);
    const email = typeof user?.email === 'string' ? user.email : '';
    const username = typeof user?.username === 'string' ? user.username : '';

    const needle = String(keywords || '')
      .trim()
      .slice(0, 100);
    const safeRegex = needle ? new RegExp(escapeRegex(needle), 'i') : undefined;
    const matchingRecords: DiagnosticModuleResult['matchingRecords'] = [];
    let nextIndex = 0;
    let hitLimit = false;
    const queriedCollectionNames: string[] = [];

    // Limit simultaneous collection queries so diagnostic reads cannot fan out
    // into an unbounded burst against MongoDB.
    const workers = Array.from(
      {
        length: Math.min(
          MAX_COLLECTION_QUERY_CONCURRENCY,
          collectionNames.length,
        ),
      },
      async () => {
        while (
          nextIndex < collectionNames.length &&
          matchingRecords.length < MAX_DOCUMENTS_TOTAL &&
          Date.now() < deadlineMs
        ) {
          const index = nextIndex++;
          const collectionName = collectionNames[index];
          queriedCollectionNames.push(collectionName);
          try {
            const identityValues: unknown[] = [userObjectId, userId];
            const identityClauses: Record<string, unknown>[] =
              USER_REFERENCE_FIELDS.map((field) => ({
                [field]: { $in: identityValues },
              }));
            if (email) {
              identityClauses.push(
                { email },
                { 'user.email': email },
                { 'account.email': email },
                { 'customer.email': email },
                { 'profile.email': email },
              );
            }
            if (username) {
              identityClauses.push(
                { username },
                { 'user.username': username },
                { 'account.username': username },
              );
            }
            // Keyword search across shared records is permitted only for explicitly
            // recognized non-customer-owned collections. User-owned collections remain
            // constrained to the authenticated user's identity even when keywords exist.
            if (collectionName === 'users')
              identityClauses.push({ _id: userObjectId });
            const collection = db.collection(collectionName);
            const sort = { updatedAt: -1, createdAt: -1 } as const;
            let docs: Record<string, unknown>[] = [];

            if (safeRegex && isSharedSearchCollection(collectionName)) {
              // Search explicitly named public/reference data without scanning whole
              // collections or allowing model-supplied query operators.
              const searchClauses = SEARCHABLE_FIELDS.map((field) => ({
                [field]: safeRegex,
              }));
              docs = await collection
                .find({ $or: searchClauses })
                .sort(sort)
                .limit(MAX_DOCUMENTS_PER_COLLECTION)
                .maxTimeMS(MAX_DIAGNOSTIC_QUERY_MS)
                .toArray();
            } else if (safeRegex) {
              // For user-owned data, prioritize records matching the issue keywords,
              // then fill remaining slots with that same user's latest records.
              const keywordClauses = SEARCHABLE_FIELDS.map((field) => ({
                [field]: safeRegex,
              }));
              try {
                docs = await collection
                  .find({
                    $and: [{ $or: identityClauses }, { $or: keywordClauses }],
                  })
                  .sort(sort)
                  .limit(MAX_DOCUMENTS_PER_COLLECTION)
                  .maxTimeMS(MAX_DIAGNOSTIC_QUERY_MS)
                  .toArray();
              } catch {
                // Keyword matching may be unsupported/too costly for a particular
                // collection; the bounded identity-scoped query below remains available.
              }
              if (docs.length < MAX_DOCUMENTS_PER_COLLECTION) {
                const latest = await collection
                  .find({ $or: identityClauses })
                  .sort(sort)
                  .limit(MAX_DOCUMENTS_PER_COLLECTION)
                  .maxTimeMS(MAX_DIAGNOSTIC_QUERY_MS)
                  .toArray();
                const seen = new Set(docs.map((doc) => documentId(doc._id)));
                for (const doc of latest) {
                  if (docs.length >= MAX_DOCUMENTS_PER_COLLECTION) break;
                  const key = documentId(doc._id);
                  if (!seen.has(key)) {
                    docs.push(doc);
                    seen.add(key);
                  }
                }
              }
            } else {
              docs = await collection
                .find({ $or: identityClauses })
                .sort(sort)
                .limit(MAX_DOCUMENTS_PER_COLLECTION)
                .maxTimeMS(MAX_DIAGNOSTIC_QUERY_MS)
                .toArray();
            }
            for (const doc of docs) {
              if (matchingRecords.length >= MAX_DOCUMENTS_TOTAL) {
                hitLimit = true;
                break;
              }
              matchingRecords.push({
                collection: collectionName,
                document: sanitizeDocument(doc) as Record<string, unknown>,
              });
            }
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            warnings.push(
              `${collectionName}: diagnostic query was skipped or timed out.`,
            );
            this.logger.warn(
              `Read-only support diagnostic failed for collection ${collectionName}: ${message}`,
            );
          }
        }
      },
    );
    await Promise.all(workers);

    if (matchingRecords.length >= MAX_DOCUMENTS_TOTAL || hitLimit) {
      warnings.push(
        `Results were capped at ${MAX_DOCUMENTS_TOTAL} documents. Groq can request a narrower module inspection for more detail.`,
      );
    }
    if (nextIndex < collectionNames.length) {
      warnings.push(
        `Inspection stopped at its ${MAX_INSPECTION_RUNTIME_MS} ms safety budget or document cap; ${collectionNames.length - nextIndex} selected collections were not queried in this pass. Request a targeted module inspection to continue safely.`,
      );
    }

    const technicalSignals: DiagnosticModuleResult['technicalSignals'] = [];
    // Cross-check the most recent approved subscription-related payment against
    // the actual subscription table. This uses the existing schema fields and is
    // only a diagnostic signal; it never alters either business record.
    if (
      ['all', 'payments', 'payment-gateways', 'subscriptions'].includes(
        normalizedModule,
      )
    ) {
      try {
        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
        // Allow the payment/entitlement transaction a short grace period before
        // labelling a mismatch as technical. Prefer processedAt because payment
        // records may have been created before the user completed checkout.
        const graceCutoff = new Date(Date.now() - 5 * 60 * 1000);
        const payment = await db
          .collection('payments')
          .find({
            userId: { $in: [userId, userObjectId] },
            status: 'approved',
            type: { $in: ['subscription', 'vip_upgrade', 'premium_upgrade'] },
            $or: [
              { processedAt: { $gte: cutoff, $lte: graceCutoff } },
              {
                processedAt: null,
                createdAt: { $gte: cutoff, $lte: graceCutoff },
              },
            ],
          })
          .sort({ processedAt: -1, createdAt: -1 })
          .limit(1)
          .maxTimeMS(MAX_DIAGNOSTIC_QUERY_MS)
          .next();
        if (payment) {
          const expectedPlan =
            payment.type === 'vip_upgrade'
              ? 'vip'
              : payment.type === 'premium_upgrade'
                ? 'premium'
                : String(payment.target ?? '')
                    .trim()
                    .toLowerCase();
          const activeSubscription = await db
            .collection('subscriptions')
            .findOne(
              {
                userId: { $in: [userId, userObjectId] },
                ...(['regular', 'vip', 'premium'].includes(expectedPlan)
                  ? { plan: expectedPlan }
                  : {}),
                isActive: true,
                expiryDate: { $gt: new Date() },
              },
              {
                projection: { _id: 1, plan: 1, expiryDate: 1 },
                maxTimeMS: 700,
              },
            );
          if (!activeSubscription) {
            technicalSignals.push({
              code: 'RECENT_APPROVED_PAYMENT_WITHOUT_ACTIVE_SUBSCRIPTION',
              severity: 'HIGH',
              summary:
                'A subscription-related payment approved at least five minutes ago has no active subscription record matching its target plan.',
              evidence: [
                `Approved payment type: ${String(payment.type ?? 'unknown')}.`,
                `Expected subscription plan: ${expectedPlan || 'unknown'}.`,
                'No matching active, unexpired subscription record was found for the authenticated account.',
              ],
            });
          }
        }
      } catch {
        warnings.push(
          'Payment/subscription consistency check was unavailable; no conclusion was inferred.',
        );
      }
    }

    return {
      module: normalizedModule,
      inspectedAt: new Date().toISOString(),
      collectionNames: [...new Set(queriedCollectionNames)],
      matchingRecords,
      technicalSignals,
      warnings: [...new Set(warnings)],
    };
  }

  async getSystemHealth(): Promise<Record<string, unknown>> {
    try {
      const [dashboardValue, databaseValue, databaseOperationsValue] =
        await Promise.all([
          this.systemMonitor.getDashboard(),
          this.storageMonitor.getDatabaseHealth(),
          Promise.resolve(
            this.databaseTracker.getOperations({ limit: 20, status: 'FAILED' }),
          ),
        ]);
      const raw = asRecord(dashboardValue);
      const databaseHealth = asRecord(databaseValue);
      const failedDatabaseOperations = Array.isArray(
        asRecord(databaseOperationsValue).recent,
      )
        ? (asRecord(databaseOperationsValue).recent as unknown[])
        : [];
      const system =
        raw.system && typeof raw.system === 'object'
          ? asRecord(raw.system)
          : {};
      const summary =
        raw.summary && typeof raw.summary === 'object'
          ? asRecord(raw.summary)
          : {};
      const memory = asRecord(system.memory);
      const modules = Array.isArray(raw?.modules)
        ? raw.modules.slice(0, 80)
        : [];
      const crons = Array.isArray(raw?.crons) ? raw.crons.slice(0, 80) : [];
      const recentErrors = Array.isArray(raw?.recentErrors)
        ? raw.recentErrors.slice(0, 12)
        : [];
      const recentActivity = Array.isArray(raw?.recentActivity)
        ? raw.recentActivity.slice(0, 20)
        : [];

      // Return a diagnosis-friendly view, not raw process internals, stacks, PIDs,
      // or arbitrary runtime telemetry. The admin dashboard retains full detail.
      return {
        checkedAt: new Date().toISOString(),
        system: {
          status: sanitizeString(system.status, 40),
          uptimeSeconds: finiteNumber(system.uptimeSeconds),
          nodeVersion: sanitizeString(system.nodeVersion, 40),
          memory:
            system.memory && typeof system.memory === 'object'
              ? {
                  rssBytes: finiteNumber(memory.rssBytes),
                  heapUsedBytes: finiteNumber(memory.heapUsedBytes),
                  heapTotalBytes: finiteNumber(memory.heapTotalBytes),
                }
              : undefined,
        },
        summary: sanitizeDocument(summary),
        database: {
          status: sanitizeString(databaseHealth.status, 40),
          state: sanitizeString(databaseHealth.state, 40),
          readyState: finiteNumber(databaseHealth.readyState),
          pingMs: finiteNumber(databaseHealth.pingMs),
          collections: finiteNumber(databaseHealth.collections),
          documents: finiteNumber(databaseHealth.documents),
          dataSizeBytes: finiteNumber(databaseHealth.dataSizeBytes),
          storageSizeBytes: finiteNumber(databaseHealth.storageSizeBytes),
          indexSizeBytes: finiteNumber(databaseHealth.indexSizeBytes),
          totalSizeBytes: finiteNumber(databaseHealth.totalSizeBytes),
          checkedAt: databaseHealth.checkedAt,
        },
        failedDatabaseOperations: Array.isArray(failedDatabaseOperations)
          ? failedDatabaseOperations.map((value: unknown) => {
              const item = asRecord(value);
              return {
                collection: sanitizeString(item.collection, 120),
                command: sanitizeString(item.command, 80),
                status: sanitizeString(item.status, 30),
                durationMs: finiteNumber(item.durationMs),
                message: sanitizeFreeText(item.message, 300),
                occurredAt: item.occurredAt,
              };
            })
          : [],
        modules: modules.map((value: unknown) => {
          const item = asRecord(value);
          return {
            module: sanitizeString(item.module, 100),
            status: sanitizeString(item.status, 40),
            critical: item.critical === true,
            monitoringLevel: sanitizeString(item.monitoringLevel, 40),
            message: sanitizeFreeText(item.message, 500),
            source: sanitizeString(item.source, 100),
            checkedAt: item.checkedAt,
            consecutiveFailures: finiteNumber(item.consecutiveFailures),
            activeOperations: finiteNumber(item.activeOperations),
            lastOperation: sanitizeString(item.lastOperation, 100),
          };
        }),
        crons: crons.map((value: unknown) => {
          const item = asRecord(value);
          return {
            key: sanitizeString(item.key, 120),
            module: sanitizeString(item.module, 100),
            name: sanitizeString(item.name, 150),
            status: sanitizeString(item.status, 40),
            enabled: item.enabled === true,
            consecutiveFailures: finiteNumber(item.consecutiveFailures),
            lastError: sanitizeFreeText(item.lastError, 350),
            lastStartedAt: item.lastStartedAt,
            lastSuccessfulAt: item.lastSuccessfulAt,
            lastFailedAt: item.lastFailedAt,
          };
        }),
        recentErrors: recentErrors.map((value: unknown) => {
          const item = asRecord(value);
          return {
            module: sanitizeString(item.module, 100),
            source: sanitizeString(item.source, 100),
            operation: sanitizeString(item.operation, 120),
            message: sanitizeFreeText(item.message, 500),
            occurredAt: item.occurredAt,
            referenceKey: sanitizeString(item.referenceKey, 120),
          };
        }),
        recentActivity: recentActivity.map((value: unknown) => {
          const item = asRecord(value);
          return {
            module: sanitizeString(item.module, 100),
            source: sanitizeString(item.source, 100),
            operation: sanitizeString(item.operation, 120),
            status: sanitizeString(item.status, 40),
            message: sanitizeFreeText(item.message, 350),
            occurredAt: item.occurredAt,
            durationMs: finiteNumber(item.durationMs),
            referenceKey: sanitizeString(item.referenceKey, 120),
          };
        }),
      };
    } catch {
      return {
        status: 'UNKNOWN',
        diagnosticError:
          'System Monitor is unavailable for this diagnostic request.',
      };
    }
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function documentId(value: unknown): string {
  if (value instanceof Types.ObjectId) return value.toHexString();
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint')
    return String(value);
  return '';
}

function sanitizeDocument(value: unknown, depth = 0): unknown {
  if (depth > 7) return '[DEPTH_LIMIT]';
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Types.ObjectId) return value.toHexString();
  if (Array.isArray(value))
    return value.slice(0, 30).map((item) => sanitizeDocument(item, depth + 1));
  if (typeof value !== 'object') {
    if (typeof value === 'string') return sanitizeFreeText(value, 1500);
    if (typeof value === 'bigint') return value.toString();
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_FIELD.test(key) || key === '__v') continue;
    output[key] = sanitizeDocument(item, depth + 1);
  }
  return output;
}

function sanitizeString(value: unknown, max: number): string {
  return sanitizeFreeText(value, max);
}
function sanitizeFreeText(value: unknown, max: number): string {
  const text =
    value === null || value === undefined
      ? ''
      : typeof value === 'string'
        ? value
        : typeof value === 'number' ||
            typeof value === 'boolean' ||
            typeof value === 'bigint'
          ? String(value)
          : '[structured value]';
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email redacted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(
      /(password|token|secret|authorization|cookie|api[_-]?key)\s*[:=]\s*[^\s&,;]+/gi,
      '$1=[redacted]',
    )
    .replace(
      /\b(otp|verification code|one-time code)\s*[:#-]?\s*\d{4,8}\b/gi,
      '$1 [redacted]',
    )
    .split('')
    .map((character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
        ? ' '
        : character,
    )
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function finiteNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isSharedSearchCollection(name: string): boolean {
  const normalized = name.toLowerCase();
  if (
    [
      'promos',
      'promo',
      'market_predictions',
      'predictions_engine_markets',
      'predictions_engine_pick_center',
      'predictions_engine_calibrations',
      'curated_predictions',
      'pick_center',
    ].includes(normalized)
  )
    return true;
  return [
    'sports_',
    'espn_',
    'football_data',
    'active_competition',
    'youtube_highlight',
    'odds_',
    'fixture_odds',
    'sports_fixture_odds',
    'sports_odds_snapshot',
    'odds_api_sport',
    'predictions_engine_',
  ].some((prefix) => normalized.startsWith(prefix));
}
