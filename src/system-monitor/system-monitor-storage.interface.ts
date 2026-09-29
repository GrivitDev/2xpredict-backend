// ============================================================
// STORAGE COLLECTION
// ============================================================

export interface SystemMonitorStorageCollection {
  name: string;

  documents: number;

  dataSizeBytes: number;

  storageSizeBytes: number;

  averageDocumentSizeBytes: number;

  indexes: number;

  totalIndexSizeBytes: number;

  totalSizeBytes: number;
}

// ============================================================
// STORAGE TOTALS
// ============================================================

export interface SystemMonitorStorageTotals {
  collections: number;

  documents: number;

  dataSizeBytes: number;

  storageSizeBytes: number;

  indexSizeBytes: number;

  totalSizeBytes: number;
}

// ============================================================
// STORAGE SNAPSHOT
// ============================================================

export interface SystemMonitorStorageSnapshot {
  capturedAt: Date;

  databaseName: string;

  totals: SystemMonitorStorageTotals;

  collections: SystemMonitorStorageCollection[];
}

// ============================================================
// STORAGE RESPONSE
// ============================================================

export interface SystemMonitorStorageResponse extends SystemMonitorStorageSnapshot {
  persistedAt?: Date;
}

// ============================================================
// STORAGE HISTORY
// ============================================================

export interface SystemMonitorStorageHistoryItem {
  capturedAt: Date;

  databaseName: string;

  totals: SystemMonitorStorageTotals;
}
