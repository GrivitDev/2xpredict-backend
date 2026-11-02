export interface PredictionQueueSyncResult {
  scannedFixtures: number;
  eligibleFixtures: number;
  enqueued: number;
  refreshed: number;
  missingSummary: number;
  oddsNotReady?: number;
}

export interface PredictionQueueWorkItem {
  eventId: string;
  leagueId: string;
  fixtureDate: Date;
  priority: number;
  attempts: number;
  summaryCollectedAt?: Date | string | null;
}
