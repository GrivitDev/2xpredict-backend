export const BASELINE_1X2_SELECTION_KEYS = [
  'HOME_WIN',
  'DRAW',
  'AWAY_WIN',
] as const;

export type Baseline1X2SelectionKey =
  (typeof BASELINE_1X2_SELECTION_KEYS)[number];

export interface FixtureCoverageAuditInput {
  now: Date;
  kickoffAt: Date | string;
  fixtureStatus?: { state?: string; isFinal?: boolean } | null;
  homeTeamId?: string | null;
  awayTeamId?: string | null;
  predictionHorizonHours: number;
  oddsHorizonHours: number;
  predictionModelVersion: string;
  oddsModelVersion: string;
  currentFixtureSourceRevision: number;
  queue?: {
    status?: string;
    modelVersion?: string;
    sourceRevisionFingerprint?: string;
  } | null;
  predictionDocument?: {
    modelVersion?: string;
    status?: string;
    fixtureSourceRevision?: number;
    sourceRevisionFingerprint?: string;
    selections?: Array<{
      key?: string;
      status?: string;
      probability?: number | null;
      confidence?: number | null;
      evidenceConfidence?: number | null;
      evidenceLevel?: string;
      dataQuality?: number | null;
      isFinalSelection?: boolean;
    }>;
  } | null;
  hasPredictionDocumentFromOtherModel?: boolean;
  oddsQuotes?: Array<{
    selectionKey?: string;
    decimalOdds?: number;
    priceType?: string;
    pricingSource?: string;
    predictionReady?: boolean;
    pricingStatus?: string;
    isFresh?: boolean;
    oddsBasis?: string;
    calculationVersion?: string;
    fixtureSourceRevision?: number;
    sourceDataHash?: string;
  }>;
  maximumDecimalOdds: number;
}

export interface FixtureCoverageAuditResult {
  eligible: boolean;
  exclusionReasons: string[];
  predictionRequired: boolean;
  oddsRequired: boolean;
  queuePresent: boolean;
  predictionCovered: boolean;
  oddsCovered: boolean;
  fullyCovered: boolean;
  predictionSelectionCount: number;
  oddsSelectionCount: number;
  probabilityTotal: number | null;
  queueCovered: boolean;
  predictionProvisional: boolean;
  predictionEvidenceLevels: string[];
  oddsProvisional: boolean;
  oddsBases: string[];
  pendingRecalculation: boolean;
  failedCalculation: boolean;
  missingFixtureInformation: string[];
  missingTeamInformation: string[];
  issueCodes: string[];
}

const TERMINAL_FIXTURE_STATES = new Set([
  'COMPLETED',
  'POSTPONED',
  'CANCELLED',
  'CANCELED',
  'ABANDONED',
]);

const LIVE_FIXTURE_STATES = new Set([
  'LIVE',
  'HALFTIME',
  'EXTRA_TIME',
  'PENALTIES',
  'IN_PROGRESS',
  'INPLAY',
  'IN_PLAY',
  'PLAYING',
  'SUSPENDED',
  'INTERRUPTED',
]);

const VALID_ODDS_BASES = new Set([
  'BOOKMAKER_ONLY',
  'BOOKMAKER_PLUS_HISTORY',
  'HISTORICAL_ONLY',
  'PRIOR_ONLY',
]);

const validProbability = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1;

const validDecimalOdds = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 1.01;

/**
 * Read-only coverage assessment for the baseline Full-Time Match Result (1X2).
 * Advanced markets are deliberately excluded because their evidence requirements
 * remain market-specific.
 */
export function evaluateFixtureCoverage(
  input: FixtureCoverageAuditInput,
): FixtureCoverageAuditResult {
  const issues: string[] = [];
  const exclusions: string[] = [];
  const kickoff = new Date(input.kickoffAt);
  const nowMs = input.now.getTime();
  const kickoffMs = kickoff.getTime();
  const state = String(input.fixtureStatus?.state ?? 'UNKNOWN').trim().toUpperCase();
  const homeTeamId = String(input.homeTeamId ?? '').trim();
  const awayTeamId = String(input.awayTeamId ?? '').trim();

  if (!Number.isFinite(kickoffMs)) exclusions.push('INVALID_KICKOFF');
  else if (kickoffMs <= nowMs) exclusions.push('NOT_FUTURE');
  if (input.fixtureStatus?.isFinal === true || TERMINAL_FIXTURE_STATES.has(state)) {
    exclusions.push('TERMINAL_FIXTURE');
  }
  if (LIVE_FIXTURE_STATES.has(state)) exclusions.push('LIVE_FIXTURE');
  if (!homeTeamId) exclusions.push('MISSING_HOME_TEAM_ID');
  if (!awayTeamId) exclusions.push('MISSING_AWAY_TEAM_ID');

  const eligible = exclusions.length === 0;
  const missingFixtureInformation = exclusions.filter((reason) =>
    reason === 'INVALID_KICKOFF',
  );
  const missingTeamInformation = exclusions.filter((reason) =>
    reason === 'MISSING_HOME_TEAM_ID' || reason === 'MISSING_AWAY_TEAM_ID',
  );
  const predictionRequired = eligible
    && kickoffMs <= nowMs + Math.max(0, input.predictionHorizonHours) * 3_600_000;
  const oddsRequired = eligible
    && kickoffMs <= nowMs + Math.max(0, input.oddsHorizonHours) * 3_600_000;

  const queuePresent = Boolean(input.queue);
  if (predictionRequired && !queuePresent) {
    issues.push('PREDICTION_QUEUE_MISSING');
  } else if (predictionRequired && input.queue) {
    if (input.queue.modelVersion !== input.predictionModelVersion) {
      issues.push('PREDICTION_QUEUE_MODEL_VERSION_STALE');
    }
    const queueStatus = String(input.queue.status ?? '').toUpperCase();
    if (queueStatus === 'FAILED') {
      issues.push('PREDICTION_QUEUE_FAILED');
    } else if (queueStatus === 'SKIPPED') {
      issues.push('PREDICTION_QUEUE_SKIPPED');
    } else if (queueStatus === 'WAITING_FOR_ODDS') {
      issues.push('PREDICTION_QUEUE_WAITING_FOR_ODDS');
    }
  }

  let predictionCovered = !predictionRequired;
  let predictionSelectionCount = 0;
  let probabilityTotal: number | null = null;
  let predictionProvisional = false;
  let predictionEvidenceLevels: string[] = [];
  let predictionFailed = false;

  if (predictionRequired) {
    const document = input.predictionDocument;
    if (!document) {
      issues.push(
        input.hasPredictionDocumentFromOtherModel
          ? 'BASELINE_PREDICTION_MODEL_VERSION_STALE'
          : 'BASELINE_PREDICTION_MISSING',
      );
    } else {
      if (document.modelVersion !== input.predictionModelVersion) {
        issues.push('BASELINE_PREDICTION_MODEL_VERSION_STALE');
      }
      const predictionStatus = String(document.status ?? '').toUpperCase();
      if (predictionStatus !== 'CALCULATED') {
        issues.push('BASELINE_PREDICTION_NOT_CALCULATED');
      }
      if (predictionStatus === 'FAILED') {
        predictionFailed = true;
        issues.push('BASELINE_PREDICTION_FAILED');
      }
      if (
        Number(document.fixtureSourceRevision ?? -1)
        !== input.currentFixtureSourceRevision
      ) {
        issues.push('BASELINE_PREDICTION_SOURCE_REVISION_STALE');
      }
      const queueFingerprint = String(
        input.queue?.sourceRevisionFingerprint ?? '',
      ).trim();
      const documentFingerprint = String(
        document.sourceRevisionFingerprint ?? '',
      ).trim();
      if (queueFingerprint && queueFingerprint !== documentFingerprint) {
        issues.push('BASELINE_PREDICTION_SOURCE_FINGERPRINT_STALE');
      }

      const selections = Array.isArray(document.selections)
        ? document.selections
        : [];
      const selectionsByKey = new Map<string, (typeof selections)[number]>();
      for (const selection of selections) {
        const key = String(selection?.key ?? '').trim().toUpperCase();
        if (key && BASELINE_1X2_SELECTION_KEYS.includes(key as Baseline1X2SelectionKey)) {
          selectionsByKey.set(key, selection);
        }
      }
      const baselineSelections = BASELINE_1X2_SELECTION_KEYS.map((key) =>
        selectionsByKey.get(key),
      );
      predictionSelectionCount = baselineSelections.filter(Boolean).length;
      predictionEvidenceLevels = [...new Set(
        baselineSelections
          .map((selection) => String(selection?.evidenceLevel ?? '').trim())
          .filter(Boolean),
      )];
      predictionProvisional = predictionStatus === 'CALCULATED'
        && predictionEvidenceLevels.some((level) =>
          ['PRIOR_ONLY', 'LIMITED', 'DEVELOPING'].includes(level),
        );
      const allCalculated = baselineSelections.every(
        (selection) =>
          Boolean(selection)
          && String(selection?.status ?? '').toUpperCase() === 'CALCULATED'
          && validProbability(selection?.probability),
      );

      if (!allCalculated) {
        issues.push('BASELINE_PREDICTION_1X2_INCOMPLETE');
      } else {
        const confidenceValid = baselineSelections.every((selection) => {
          const confidence = Number(selection?.confidence);
          return Number.isFinite(confidence) && confidence >= 40 && confidence <= 98;
        });
        if (!confidenceValid) {
          issues.push('BASELINE_PREDICTION_CONFIDENCE_INVALID');
        }
        const allowedEvidenceLevels = new Set([
          'PRIOR_ONLY',
          'LIMITED',
          'DEVELOPING',
          'STRONG',
          'MARKET_SPECIFIC',
        ]);
        const evidenceMetadataValid = baselineSelections.every((selection) => {
          const evidenceConfidence = Number(selection?.evidenceConfidence);
          const dataQuality = Number(selection?.dataQuality);
          return allowedEvidenceLevels.has(String(selection?.evidenceLevel ?? ''))
            && Number.isFinite(evidenceConfidence)
            && evidenceConfidence >= 0
            && evidenceConfidence <= 98
            && Number.isFinite(dataQuality)
            && dataQuality >= 0
            && dataQuality <= 1;
        });
        if (!evidenceMetadataValid) {
          issues.push('BASELINE_PREDICTION_EVIDENCE_METADATA_INVALID');
        }
        probabilityTotal = baselineSelections.reduce(
          (sum, selection) => sum + Number(selection?.probability),
          0,
        );
        if (Math.abs(probabilityTotal - 1) > 0.001) {
          issues.push('BASELINE_PREDICTION_PROBABILITIES_NOT_NORMALIZED');
        }
      }

      const finalSelectionCount = baselineSelections.filter(
        (selection) => selection?.isFinalSelection === true,
      ).length;
      if (finalSelectionCount !== 1) {
        issues.push('BASELINE_PREDICTION_FINAL_SELECTION_INVALID');
      }
    }

    predictionCovered = !issues.some((issue) =>
      issue.startsWith('BASELINE_PREDICTION_'),
    );
  }

  let oddsCovered = !oddsRequired;
  let oddsSelectionCount = 0;
  let oddsProvisional = false;
  let oddsBases: string[] = [];
  if (oddsRequired) {
    const quotes = (input.oddsQuotes ?? []).filter(
      (quote) => quote.calculationVersion === input.oddsModelVersion,
    );
    const quoteByKey = new Map<string, (typeof quotes)[number]>();
    for (const quote of quotes) {
      const key = String(quote.selectionKey ?? '').trim().toUpperCase();
      if (key && BASELINE_1X2_SELECTION_KEYS.includes(key as Baseline1X2SelectionKey)) {
        quoteByKey.set(key, quote);
      }
    }

    const usableQuotes = BASELINE_1X2_SELECTION_KEYS.map((key) =>
      quoteByKey.get(key),
    );
    oddsSelectionCount = usableQuotes.filter(Boolean).length;
    oddsBases = [...new Set(
      usableQuotes
        .map((quote) => String(quote?.oddsBasis ?? '').trim())
        .filter(Boolean),
    )];
    oddsProvisional = oddsSelectionCount === BASELINE_1X2_SELECTION_KEYS.length
      && oddsBases.includes('PRIOR_ONLY');
    if (!quotes.length) {
      issues.push('GRIVIT_BASELINE_ODDS_MISSING');
    } else if (oddsSelectionCount !== BASELINE_1X2_SELECTION_KEYS.length) {
      issues.push('GRIVIT_BASELINE_ODDS_1X2_INCOMPLETE');
    }

    const allQuotesUsable = usableQuotes.every(
      (quote) =>
        Boolean(quote)
        && quote?.pricingSource === 'GRIVIT_MODEL'
        && (quote?.priceType === 'ESTIMATED' || quote?.priceType === 'PROVIDER')
        && String(quote?.pricingStatus ?? 'CURRENT').toUpperCase() !== 'STALE'
        && quote?.isFresh === true
        && validDecimalOdds(quote?.decimalOdds)
        && Number(quote?.decimalOdds) <= input.maximumDecimalOdds
        && Boolean(String(quote?.sourceDataHash ?? '').trim())
        && VALID_ODDS_BASES.has(String(quote?.oddsBasis ?? '')),
    );
    if (oddsSelectionCount === BASELINE_1X2_SELECTION_KEYS.length && !allQuotesUsable) {
      issues.push('GRIVIT_BASELINE_ODDS_NOT_READY');
    }

    const staleOdds = usableQuotes.some(
      (quote) =>
        Boolean(quote)
        && Number(quote?.fixtureSourceRevision ?? -1)
          !== input.currentFixtureSourceRevision,
    );
    if (staleOdds) issues.push('GRIVIT_BASELINE_ODDS_SOURCE_REVISION_STALE');

    oddsCovered =
      oddsSelectionCount === BASELINE_1X2_SELECTION_KEYS.length
      && allQuotesUsable
      && !staleOdds;
  }

  const queueCovered = !predictionRequired || (
    queuePresent
    && !issues.includes('PREDICTION_QUEUE_MODEL_VERSION_STALE')
    && !issues.includes('PREDICTION_QUEUE_FAILED')
    && !issues.includes('PREDICTION_QUEUE_SKIPPED')
    && !issues.includes('PREDICTION_QUEUE_WAITING_FOR_ODDS')
  );
  const hasRequiredCoverage = predictionRequired || oddsRequired;
  // Coverage measures the persisted match-level outputs, not whether the
  // operational queue row still exists. Queue gaps remain visible separately.
  const fullyCovered = eligible
    && hasRequiredCoverage
    && (!predictionRequired || predictionCovered)
    && (!oddsRequired || oddsCovered);
  const pendingRecalculation = issues.some((issue) =>
    issue.includes('SOURCE_REVISION_STALE')
    || issue.includes('SOURCE_FINGERPRINT_STALE')
    || issue.includes('MODEL_VERSION_STALE'),
  );
  const failedCalculation = predictionFailed
    || issues.includes('PREDICTION_QUEUE_FAILED');

  return {
    eligible,
    exclusionReasons: exclusions,
    predictionRequired,
    oddsRequired,
    queuePresent,
    predictionCovered,
    oddsCovered,
    fullyCovered,
    predictionSelectionCount,
    oddsSelectionCount,
    probabilityTotal,
    queueCovered,
    predictionProvisional,
    predictionEvidenceLevels,
    oddsProvisional,
    oddsBases,
    pendingRecalculation,
    failedCalculation,
    missingFixtureInformation,
    missingTeamInformation,
    issueCodes: [...new Set(issues)],
  };
}