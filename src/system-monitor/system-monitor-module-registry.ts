/**
 * Canonical dependency and monitoring contract for 2xPredict.
 *
 * moduleImports records actual Nest module imports (excluding framework-only
 * modules). dataDependencies records cross-module collections read or written
 * directly without importing the owning domain module. runtimeDependencies
 * records shared infrastructure injected globally or required at runtime.
 * dependsOn is the de-duplicated union used for readiness evaluation.
 */

export type SystemMonitorModuleCategory =
  | 'infrastructure'
  | 'identity'
  | 'commerce'
  | 'sports-data'
  | 'predictions'
  | 'engagement'
  | 'communications'
  | 'support'
  | 'analytics'
  | 'observability';

export type SystemMonitorProbeMode =
  | 'PERIODIC'
  | 'WORKER_LIFECYCLE'
  | 'LIFECYCLE'
  | 'ON_DEMAND'
  | 'REQUEST_OBSERVED';

export type SystemMonitorExternalProbeMode =
  | 'MODULE_MONITORED'
  | 'REQUEST_OBSERVED'
  | 'CONFIGURATION_ONLY'
  | 'NONE';

export interface SystemMonitorModuleDefinition {
  module: string;
  category: SystemMonitorModuleCategory;
  description: string;
  monitoringLevel: 'deep' | 'health';
  critical: boolean;
  probeMode: SystemMonitorProbeMode;
  /** Stale healthy snapshots become UNKNOWN after this period. */
  healthFreshnessMs?: number;
  /** Actual non-framework Nest module imports. */
  moduleImports: readonly string[];
  /** Direct model/collection dependencies without an owning-module import. */
  dataDependencies: readonly string[];
  /** Shared/global providers and infrastructure dependencies. */
  runtimeDependencies: readonly string[];
  /** Unique union of moduleImports, dataDependencies and runtimeDependencies. */
  dependsOn: readonly string[];
  externalDependencies: readonly string[];
  externalProbeMode: SystemMonitorExternalProbeMode;
}

type SystemMonitorModuleDefinitionInput = Omit<
  SystemMonitorModuleDefinition,
  'dependsOn'
>;

const moduleDefinition = (
  definition: SystemMonitorModuleDefinitionInput,
): SystemMonitorModuleDefinition => {
  const moduleImports = [...new Set(definition.moduleImports)];
  const dataDependencies = [...new Set(definition.dataDependencies)];
  const runtimeDependencies = [...new Set(definition.runtimeDependencies)];
  const dependsOn = [...new Set([
    ...moduleImports,
    ...dataDependencies,
    ...runtimeDependencies,
  ])];

  return Object.freeze({
    ...definition,
    moduleImports: Object.freeze(moduleImports),
    dataDependencies: Object.freeze(dataDependencies),
    runtimeDependencies: Object.freeze(runtimeDependencies),
    dependsOn: Object.freeze(dependsOn),
    externalDependencies: Object.freeze([...definition.externalDependencies]),
  });
};

export const SYSTEM_MONITOR_MODULE_REGISTRY: readonly SystemMonitorModuleDefinition[] = Object.freeze([
  moduleDefinition({
    module: 'application', category: 'infrastructure',
    description: 'Application process lifecycle and in-process runtime telemetry.',
    monitoringLevel: 'health', critical: true, probeMode: 'LIFECYCLE',
    moduleImports: [], dataDependencies: [], runtimeDependencies: ['database'],
    externalDependencies: [], externalProbeMode: 'NONE',
  }),
  moduleDefinition({
    module: 'database', category: 'infrastructure',
    description: 'MongoDB connectivity, command telemetry, indexes and storage.',
    monitoringLevel: 'deep', critical: true, probeMode: 'PERIODIC',
    healthFreshnessMs: 75 * 60_000,
    moduleImports: [], dataDependencies: [], runtimeDependencies: [],
    externalDependencies: ['MongoDB'], externalProbeMode: 'MODULE_MONITORED',
  }),
  moduleDefinition({
    module: 'common', category: 'infrastructure',
    description: 'Shared application utilities and common service providers.',
    monitoringLevel: 'health', critical: false, probeMode: 'LIFECYCLE',
    moduleImports: [], dataDependencies: [], runtimeDependencies: [],
    externalDependencies: [], externalProbeMode: 'NONE',
  }),
  moduleDefinition({
    module: 'rate-limiting', category: 'infrastructure',
    description: 'Shared in-process throttling configuration for protected endpoints.',
    monitoringLevel: 'health', critical: true, probeMode: 'LIFECYCLE',
    moduleImports: [], dataDependencies: [], runtimeDependencies: [],
    externalDependencies: [], externalProbeMode: 'NONE',
  }),
  moduleDefinition({
    module: 'auth', category: 'identity',
    description: 'Registration, login, password recovery, account verification and authentication.',
    monitoringLevel: 'deep', critical: true, probeMode: 'LIFECYCLE',
    moduleImports: ['users', 'user-session', 'referrals', 'otp', 'promos', 'notifications', 'common'],
    dataDependencies: [], runtimeDependencies: ['database', 'rate-limiting'],
    externalDependencies: [], externalProbeMode: 'NONE',
  }),
  moduleDefinition({
    module: 'users', category: 'identity',
    description: 'User account records, profiles and account lifecycle operations.',
    monitoringLevel: 'deep', critical: true, probeMode: 'LIFECYCLE',
    moduleImports: ['user-session'], dataDependencies: [], runtimeDependencies: ['database'],
    externalDependencies: [], externalProbeMode: 'NONE',
  }),
  moduleDefinition({
    module: 'user-session', category: 'identity',
    description: 'Authenticated session creation, lookup and revocation.',
    monitoringLevel: 'deep', critical: true, probeMode: 'LIFECYCLE',
    moduleImports: ['common'], dataDependencies: [], runtimeDependencies: ['database'],
    externalDependencies: [], externalProbeMode: 'NONE',
  }),
  moduleDefinition({
    module: 'otp', category: 'identity',
    description: 'One-time verification codes and account-recovery workflows.',
    monitoringLevel: 'deep', critical: true, probeMode: 'LIFECYCLE',
    moduleImports: ['users', 'notifications', 'referrals', 'promos'],
    dataDependencies: [], runtimeDependencies: ['database'],
    externalDependencies: [], externalProbeMode: 'NONE',
  }),
  moduleDefinition({
    module: 'notifications', category: 'communications',
    description: 'In-app notification events, preferences and delivery orchestration.',
    monitoringLevel: 'deep', critical: false, probeMode: 'LIFECYCLE',
    moduleImports: ['email', 'users', 'user-session'],
    dataDependencies: [], runtimeDependencies: ['database', 'realtime'],
    externalDependencies: [], externalProbeMode: 'NONE',
  }),
  moduleDefinition({
    module: 'email', category: 'communications',
    description: 'Transactional email service used by identity, payment and subscription workflows.',
    monitoringLevel: 'deep', critical: false, probeMode: 'LIFECYCLE',
    moduleImports: [], dataDependencies: [], runtimeDependencies: ['realtime'],
    externalDependencies: ['Resend API'], externalProbeMode: 'REQUEST_OBSERVED',
  }),
  moduleDefinition({
    module: 'payments', category: 'commerce',
    description: 'Payment records, payment state transitions and subscription payment business rules.',
    monitoringLevel: 'deep', critical: true, probeMode: 'LIFECYCLE',
    moduleImports: ['users', 'subscriptions', 'realtime', 'referrals', 'plan-config', 'email', 'promos'],
    dataDependencies: [], runtimeDependencies: ['database'],
    externalDependencies: [], externalProbeMode: 'NONE',
  }),
  moduleDefinition({
    module: 'payment-gateways', category: 'commerce',
    description: 'Gateway initialization, verification, callbacks and payment-provider reconciliation.',
    monitoringLevel: 'deep', critical: true, probeMode: 'LIFECYCLE',
    moduleImports: ['payments', 'users'], dataDependencies: [],
    runtimeDependencies: ['database', 'realtime'],
    externalDependencies: ['Paystack API', 'Frankfurter API (USD/NGN rate)'],
    externalProbeMode: 'REQUEST_OBSERVED',
  }),
  moduleDefinition({
    module: 'subscriptions', category: 'commerce',
    description: 'Subscription lifecycle, expiry, renewal and effective entitlements from paid terms and bonus grants.',
    monitoringLevel: 'deep', critical: true, probeMode: 'LIFECYCLE',
    moduleImports: ['users', 'email', 'plan-config'], dataDependencies: ['bonuses'],
    runtimeDependencies: ['database', 'realtime'],
    externalDependencies: [], externalProbeMode: 'NONE',
  }),
  moduleDefinition({
    module: 'plan-config', category: 'commerce',
    description: 'Canonical subscription plans, pricing and commercial configuration.',
    monitoringLevel: 'deep', critical: true, probeMode: 'LIFECYCLE',
    moduleImports: [], dataDependencies: [], runtimeDependencies: ['database'],
    externalDependencies: [], externalProbeMode: 'NONE',
  }),
  moduleDefinition({
    module: 'prediction-access', category: 'predictions',
    description: 'Prediction product access, tier entitlements and usage limits.',
    monitoringLevel: 'deep', critical: true, probeMode: 'LIFECYCLE',
    moduleImports: ['subscriptions', 'sports'], dataDependencies: ['predictions-engine'],
    runtimeDependencies: ['database'],
    externalDependencies: [], externalProbeMode: 'NONE',
  }),
  moduleDefinition({
    module: 'sports', category: 'sports-data',
    description: 'Fixture discovery, provider collection, normalization, queues and derived Sports data.',
    monitoringLevel: 'deep', critical: true, probeMode: 'PERIODIC',
    healthFreshnessMs: 5 * 60_000,
    moduleImports: ['settlement'], dataDependencies: [], runtimeDependencies: ['database'],
    externalDependencies: ['ESPN API', 'The Odds API', 'YouTube Data API'],
    externalProbeMode: 'MODULE_MONITORED',
  }),
  moduleDefinition({
    module: 'odds', category: 'sports-data',
    description: 'Canonical market catalogue, bookmaker snapshots, pricing and market readiness.',
    monitoringLevel: 'deep', critical: true, probeMode: 'PERIODIC',
    healthFreshnessMs: 5 * 60_000,
    moduleImports: ['sports'], dataDependencies: [],
    runtimeDependencies: ['database', 'realtime'],
    externalDependencies: [], externalProbeMode: 'NONE',
  }),
  moduleDefinition({
    module: 'predictions-engine', category: 'predictions',
    description: 'Prediction queue, market calculations, calibration, Pick Center and curated products.',
    monitoringLevel: 'deep', critical: true, probeMode: 'WORKER_LIFECYCLE',
    moduleImports: ['prediction-access', 'odds', 'sports', 'settlement'],
    dataDependencies: [], runtimeDependencies: ['database', 'realtime'],
    externalDependencies: [], externalProbeMode: 'NONE',
  }),
  moduleDefinition({
    module: 'settlement', category: 'predictions',
    description: 'Prediction and Bet Lab outcome processing, retries, correction handling and reconciliation.',
    monitoringLevel: 'deep', critical: true, probeMode: 'WORKER_LIFECYCLE',
    moduleImports: ['bet-lab', 'sports'], dataDependencies: ['predictions-engine'],
    runtimeDependencies: ['database', 'realtime'],
    externalDependencies: [], externalProbeMode: 'NONE',
  }),
  moduleDefinition({
    module: 'bet-lab', category: 'engagement',
    description: 'Virtual betting tickets, wallet balances, ledger integrity and ticket settlement.',
    monitoringLevel: 'deep', critical: true, probeMode: 'LIFECYCLE',
    moduleImports: ['subscriptions', 'odds', 'sports', 'settlement'],
    dataDependencies: [], runtimeDependencies: ['database', 'realtime'],
    externalDependencies: [], externalProbeMode: 'NONE',
  }),
  moduleDefinition({
    module: 'telegram', category: 'communications',
    description: 'Telegram channel and bot delivery integration.',
    monitoringLevel: 'deep', critical: false, probeMode: 'LIFECYCLE',
    moduleImports: [], dataDependencies: [], runtimeDependencies: ['realtime'],
    externalDependencies: ['Telegram Bot API'], externalProbeMode: 'REQUEST_OBSERVED',
  }),
  moduleDefinition({
    module: 'customer-care', category: 'support',
    description: 'Support conversations, diagnostic inspection, incidents, queued replies and broadcasts.',
    monitoringLevel: 'deep', critical: false, probeMode: 'LIFECYCLE',
    moduleImports: ['telegram', 'otp', 'users', 'promos', 'predictions-engine', 'system-monitor', 'realtime', 'notifications'],
    dataDependencies: [], runtimeDependencies: ['database'],
    externalDependencies: ['Groq API', 'Tavily API'], externalProbeMode: 'REQUEST_OBSERVED',
  }),
  moduleDefinition({
    module: 'ads', category: 'engagement',
    description: 'Advertisement inventory, placement, targeting and campaign delivery.',
    monitoringLevel: 'health', critical: false, probeMode: 'LIFECYCLE',
    moduleImports: ['subscriptions', 'uploads', 'plan-config'],
    dataDependencies: ['predictions-engine', 'promos'], runtimeDependencies: ['database', 'realtime', 'system-monitor'],
    externalDependencies: [], externalProbeMode: 'NONE',
  }),
  moduleDefinition({
    module: 'internal-ads', category: 'engagement',
    description: 'Internal promotional placements and creative management.',
    monitoringLevel: 'health', critical: false, probeMode: 'LIFECYCLE',
    moduleImports: ['uploads'], dataDependencies: [], runtimeDependencies: ['database', 'realtime'],
    externalDependencies: [], externalProbeMode: 'NONE',
  }),
  moduleDefinition({
    module: 'promos', category: 'engagement',
    description: 'Promo campaigns, claims, redemptions and reward eligibility.',
    monitoringLevel: 'deep', critical: false, probeMode: 'LIFECYCLE',
    moduleImports: ['referrals', 'subscriptions', 'users', 'bet-lab'],
    dataDependencies: ['payments'], runtimeDependencies: ['database'],
    externalDependencies: [], externalProbeMode: 'NONE',
  }),
  moduleDefinition({
    module: 'referrals', category: 'engagement',
    description: 'Referral attribution, subscription milestones and referral reward lifecycle.',
    monitoringLevel: 'health', critical: false, probeMode: 'LIFECYCLE',
    moduleImports: ['users'], dataDependencies: [], runtimeDependencies: ['database'],
    externalDependencies: [], externalProbeMode: 'NONE',
  }),
  moduleDefinition({
    module: 'bonuses', category: 'engagement',
    description: 'Subscription and virtual-point bonus grants, bulk processing and audit records.',
    monitoringLevel: 'health', critical: false, probeMode: 'LIFECYCLE',
    moduleImports: ['auth', 'bet-lab', 'subscriptions', 'users'],
    dataDependencies: [], runtimeDependencies: ['database', 'realtime'],
    externalDependencies: [], externalProbeMode: 'NONE',
  }),
  moduleDefinition({
    module: 'uploads', category: 'infrastructure',
    description: 'User, article, prediction, advertisement and payment-proof media uploads.',
    monitoringLevel: 'health', critical: false, probeMode: 'LIFECYCLE',
    moduleImports: [], dataDependencies: [], runtimeDependencies: ['realtime'],
    externalDependencies: ['Cloudinary API'], externalProbeMode: 'REQUEST_OBSERVED',
  }),
  moduleDefinition({
    module: 'realtime', category: 'infrastructure',
    description: 'Authenticated administrative WebSocket gateway and module event transport.',
    monitoringLevel: 'health', critical: false, probeMode: 'WORKER_LIFECYCLE',
    moduleImports: ['users', 'user-session'], dataDependencies: [],
    runtimeDependencies: [], externalDependencies: [], externalProbeMode: 'NONE',
  }),
  moduleDefinition({
    module: 'analytics', category: 'analytics',
    description: 'Operational, revenue, subscription, prediction, Sports/Odds and Bet Lab analytics.',
    monitoringLevel: 'health', critical: false, probeMode: 'LIFECYCLE',
    moduleImports: ['sports', 'odds', 'settlement', 'bet-lab'],
    dataDependencies: ['users', 'payments', 'subscriptions', 'referrals', 'promos', 'ads', 'predictions-engine'],
    runtimeDependencies: ['database', 'realtime'],
    externalDependencies: [], externalProbeMode: 'NONE',
  }),
  moduleDefinition({
    module: 'website-analytics', category: 'analytics',
    description: 'Website visitor, session, event ingestion and daily aggregate analytics.',
    monitoringLevel: 'health', critical: false, probeMode: 'LIFECYCLE',
    moduleImports: [], dataDependencies: [], runtimeDependencies: ['database', 'realtime'],
    externalDependencies: [], externalProbeMode: 'NONE',
  }),
  moduleDefinition({
    module: 'admin-users', category: 'identity',
    description: 'Administrative user operations and cross-module account diagnostics.',
    monitoringLevel: 'health', critical: false, probeMode: 'LIFECYCLE',
    moduleImports: ['users', 'payments', 'subscriptions', 'user-session', 'bet-lab', 'referrals', 'promos', 'bonuses', 'website-analytics', 'prediction-access', 'notifications'],
    dataDependencies: [], runtimeDependencies: ['database', 'realtime'],
    externalDependencies: [], externalProbeMode: 'NONE',
  }),
  moduleDefinition({
    module: 'system-monitor', category: 'observability',
    description: 'Central health, runtime, database dependency and module-graph telemetry.',
    monitoringLevel: 'health', critical: false, probeMode: 'LIFECYCLE',
    moduleImports: [], dataDependencies: [], runtimeDependencies: ['database', 'realtime'],
    externalDependencies: [], externalProbeMode: 'NONE',
  }),
]);

const DEFINITIONS_BY_KEY = new Map(
  SYSTEM_MONITOR_MODULE_REGISTRY.map((definition) => [definition.module, definition]),
);

const MODULE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  app: 'application',
  'sports-data': 'sports',
  'customer-care-worker': 'customer-care',
  'database-operations': 'database',
  'rate-limiter': 'rate-limiting',
  'predictions-engine-calibration': 'predictions-engine',
  'predictions-engine-curated': 'predictions-engine',
  'predictions-engine-slip-center': 'predictions-engine',
  'prediction-engine': 'predictions-engine',
  'prediction-read': 'predictions-engine',
  'odds-center': 'odds',
  'bonuses-admin': 'bonuses',
  'admin-ads': 'ads',
  'customer-care-admin': 'customer-care',
  'payment-gateway': 'payment-gateways',
  'realtime-gateway': 'realtime',
  'email-delivery': 'email',
});

const IGNORED_NEST_MODULES = new Set([
  'internalcore',
  'mongoosecore',
  'mongoose',
  'mongoosemodule',
  'config',
  'confighost',
  'configmodule',
  'schedule',
  'schedulemodule',
  'discovery',
  'router',
  'http',
  'httpmodule',
  'axios',
  'jwt',
  'jwtmodule',
  'passport',
  'passportmodule',
  'throttler',
  'throttlermodule',
  'throttlerroot',
  'throttlercore',
]);

export function normalizeSystemMonitorModuleKey(value: string): string {
  const key = String(value ?? 'unknown')
    .trim()
    .replace(/Module$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase() || 'unknown';
  return MODULE_ALIASES[key] ?? key;
}

/** Returns undefined for Nest framework modules that are not 2xPredict domains. */
export function resolveNestSystemMonitorModule(moduleClassName: string): string | undefined {
  const normalizedRaw = String(moduleClassName ?? '').replace(/Module$/, '');
  const compact = normalizedRaw.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  if (!normalizedRaw || IGNORED_NEST_MODULES.has(compact)) return undefined;
  return normalizeSystemMonitorModuleKey(normalizedRaw);
}

/** Resolve controller names consistently so HTTP activity is attributed correctly. */
export function resolveSystemMonitorControllerModule(controllerClassName: string): string {
  const compact = String(controllerClassName ?? '')
    .replace(/Controller$/, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase();

  const controllerAliases: Readonly<Record<string, string>> = {
    websiteanalytics: 'website-analytics',
    paymentgateways: 'payment-gateways',
    paymentgateway: 'payment-gateways',
    predictionsread: 'predictions-engine',
    predictionengine: 'predictions-engine',
    predictionaccess: 'prediction-access',
    customercareadmin: 'customer-care',
    customercare: 'customer-care',
    notificationpreferences: 'notifications',
    adminnotifications: 'notifications',
    usernotifications: 'notifications',
    resendwebhook: 'email',
    systemmonitor: 'system-monitor',
    settlementadmin: 'settlement',
    oddscenter: 'odds',
    bonusesadmin: 'bonuses',
    betlabadmin: 'bet-lab',
    betlabwallet: 'bet-lab',
    adminads: 'ads',
    internalads: 'internal-ads',
    adminusers: 'admin-users',
    usersession: 'user-session',
  };

  const exact = controllerAliases[compact];
  if (exact) return exact;

  const prefixAliases: ReadonlyArray<readonly [string, string]> = [
    ['sports', 'sports'],
    ['betlab', 'bet-lab'],
    ['subscriptions', 'subscriptions'],
    ['payments', 'payments'],
    ['ads', 'ads'],
    ['users', 'users'],
    ['auth', 'auth'],
    ['otp', 'otp'],
    ['referrals', 'referrals'],
    ['promos', 'promos'],
    ['telegram', 'telegram'],
    ['analytics', 'analytics'],
    ['uploads', 'uploads'],
    ['planconfig', 'plan-config'],
  ];
  for (const [prefix, module] of prefixAliases) {
    if (compact.startsWith(prefix)) return module;
  }

  return normalizeSystemMonitorModuleKey(
    String(controllerClassName ?? '').replace(/Controller$/, ''),
  );
}

export function getSystemMonitorModuleDefinition(
  moduleName: string,
): SystemMonitorModuleDefinition | undefined {
  return DEFINITIONS_BY_KEY.get(normalizeSystemMonitorModuleKey(moduleName));
}

export function getSystemMonitorDefaultMonitoringLevel(
  moduleName: string,
): 'deep' | 'health' {
  return getSystemMonitorModuleDefinition(moduleName)?.monitoringLevel ?? 'health';
}

export function getSystemMonitorDefaultCritical(moduleName: string): boolean {
  return getSystemMonitorModuleDefinition(moduleName)?.critical ?? false;
}
