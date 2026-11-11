export interface PredictionEngineDashboard {
  generatedAt: string;
  runtime?: {
    operations: Array<{
      name: string;
      status: 'RUNNING' | 'HEALTHY' | 'DEGRADED' | 'UNKNOWN';
      activeRuns: number;
      runs: number;
      failures: number;
      lastStartedAt?: string;
      lastCompletedAt?: string;
      lastSuccessAt?: string;
      lastDurationMs?: number;
      lastError?: string;
      lastDetails?: Record<string, unknown>;
    }>;
    alerts: Array<{
      code: string;
      severity: 'WARNING' | 'ERROR';
      message: string;
      operation?: string;
    }>;
  };
  engine: {
    enabled: boolean;
    workerRunning: boolean;
    modelVersion: string;
    timingGate: 'ODDS_READINESS';
    lastQueueSyncAt?: string;
    lastSuccessfulRunAt?: string;
    lastFailedRunAt?: string;
    lastError?: string;
    lastProductRefreshAt?: string;
    lastCuratedRefreshAt?: string;
    lastSlipRefreshAt?: string;
    lastCalibrationRefreshAt?: string;
    productRefreshIntervalMs: number;
  };
  fixtures: {
    upcoming: number;
    eligibleWithSummary: number;
    upcomingMissingSummary: number;
    live: number;
    completed: number;
  };
  predictions: {
    marketDocuments: number;
    calculatedMarketDocuments: number;
    partialMarketDocuments: number;
    unavailableMarketDocuments: number;
    failedMarketDocuments: number;
    selections: number;
    calculatedSelections: number;
    eligibleRecommendations: number;
    modelVersion: string;
    selectedPickCenterMarkets: number;
    rankedPickCenterMarkets: number;
    /** @deprecated Compatibility alias; this now reports ranked records, not publication. */
    publishedPickCenterMarkets: number;
  };
  queue: {
    pending: number;
    processing: number;
    retry: number;
    waitingForOdds: number;
    completed: number;
    failed: number;
    skipped: number;
    oldestPendingAt?: string;
  };
  runs: {
    total: number;
    completed: number;
    partial: number;
    failed: number;
    averageDurationMs: number;
    last24Hours: number;
  };
  curatedPredictions: {
    total: number;
    ready: number;
    published: number;
    settled: number;
    cancelled: number;
    upcomingWithin48Hours: number;
    live: number;
    missingForEligiblePickCenterFixtures: number;
    lastRefresh: {
      matchesScanned: number;
      eligibleFixtures: number;
      created: number;
      updated: number;
      skipped: number;
      riskRejected: number;
      oneSelectionMatches: number;
      twoSelectionMatches: number;
      threeSelectionMatches: number;
      publishedRecordsSupplemented?: number;
      publishedRecordsReconciled?: number;
      skipReasonCounts?: Record<string, number>;
      status?: string;
      durationMs?: number;
      minimumProbability?: number;
      minimumConfidence?: number;
      minimumDataQuality?: number;
      minimumSafetyScore?: number;
      error?: string;
    };
  };
  slips: {
    total: number;
    ready: number;
    published: number;
    automaticActive: number;
    sureOddsPublished: number;
    generatedToday: number;
    lastRefresh: {
      createdOrUpdated: number;
      skipped: number;
      fixtureCandidates: number;
      eligibleFixtures: number;
      eligibleFixtureDays?: number;
      eligibleEvents?: number;
      pickCenterEventsWithoutEligibleSelections?: number;
      pickCenterEventIdsWithoutEligibleSelections?: string[];
      coveredEvents?: number;
      coverageEventsRequired?: number;
      coverageEventsSatisfied?: number;
      coverageEventIdsMissing?: string[];
      coverageDatesRequired?: number;
      coverageDatesSatisfied?: number;
      coverageDatesMissing?: string[];
      coverageSlipsCreated?: number;
      /** Deprecated compatibility field; always false under the current policy. */
      sameDayFixtureCombinationProhibited?: boolean;
      sameDayFixturesAllowed?: boolean;
      crossDateCombinationsAllowed?: boolean;
      maximumSelectionsPerMatch?: number;
      publishedProductsToday?: number;
      publishedProductsTomorrow?: number;
      targetDateTodayKey?: string;
      targetDateTomorrowKey?: string;
      todayTarget?: number;
      tomorrowTarget?: number;
      todayRemaining?: number;
      tomorrowRemaining?: number;
      status?: string;
      durationMs?: number;
      minimumProbability?: number;
      minimumConfidence?: number;
      minimumDataQuality?: number;
      minimumSafetyScore?: number;
      error?: string;
    };
    withSportyBetCode: number;
    withoutSportyBetCode: number;
  };
  marketEngineWindow: {
    coverageScope: 'ALL_RETAINED_UPCOMING_FIXTURES';
    fixtures: number;
    withSummary: number;
    missingSummary: number;
    waitingForOdds: number;
  };
  calibration: {
    lastCycleStatus?: string;
    lastRefreshAt?: string;
    lastError?: string;
    marketsRefreshedLastCycle: number;
    activeMarketsLastCycle: number;
    markets: Array<{
      marketKey: string;
      sampleSize: number;
      active: boolean;
      reliabilityScore: number | null;
      brierScore: number | null;
      calibrationError: number | null;
      logLoss: number | null;
    }>;
  };
  generationWindows: {
    marketEnginesCoverageScope: 'ALL_RETAINED_UPCOMING_FIXTURES';
    curatedAndSlipForwardHours: number;
    includeLiveFixtures: boolean;
    oddsModuleReadinessRequired: boolean;
    pickCenterUsesFixtureTimeWindow: false;
  };
  quality: {
    averageConfidence: number | null;
    averageProbability: number | null;
    averageExpectedValuePercent: number | null;
    averageDataQuality: number | null;
    averageSafetyScore: number | null;
    averageCalibrationReliability: number | null;
    providerPricedSelections: number;
    estimatedPricedSelections: number;
    oddsReadySelections: number;
    calibrationAppliedSelections: number;
    recommendationEligibleSelections: number;
    missingOddsFixtures: number;
    missingHistoricalEvidenceFixtures: number;
    staleSummaries: number;
    calibrationMarkets: number;
    calibratedMarkets: number;
    calibrationSettledSelections: number;
    meanBrierScore: number | null;
    meanCalibrationError: number | null;
    meanCalibrationReliability: number | null;
    meanLogLoss: number | null;
  };
  markets: Array<{
    marketKey: string;
    marketName: string;
    documents: number;
    calculated: number;
    unavailable: number;
    selections: number;
    calculatedSelections: number;
    unavailableSelections: number;
    finalSelections: number;
    oddsReadySelections: number;
    providerPricedSelections: number;
    estimatedPricedSelections: number;
    averageProbability: number | null;
    averageConfidence: number | null;
    averageFinalProbability: number | null;
    averageFinalConfidence: number | null;
    averageFinalDataQuality: number | null;
    averageFinalSafetyScore: number | null;
    averageFinalCalibrationReliability: number | null;
    averageFinalDecimalOdds: number | null;
    averageFinalExpectedValuePercent: number | null;
  }>;
  recentEvents: Array<Record<string, unknown>>;
}

