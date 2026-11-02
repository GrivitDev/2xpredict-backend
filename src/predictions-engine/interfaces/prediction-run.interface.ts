export interface PredictionRunSummary {
  runId: string;
  eventId: string;
  status: string;
  modelVersion: string;
  startedAt: Date;
  completedAt?: Date;
  durationMs?: number;
  totalMarkets: number;
  calculatedMarkets: number;
  partialMarkets: number;
  unavailableMarkets: number;
  failedMarkets: number;
  totalSelections: number;
  calculatedSelections: number;
  averageConfidence?: number;
  generalConfidence?: number;
  expectedHomeGoals?: number;
  expectedAwayGoals?: number;
  errorMessage?: string;
}
