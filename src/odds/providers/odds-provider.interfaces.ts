export type ExternalOddsProvider = 'THE_ODDS_API';
export type StoredOddsProvider = ExternalOddsProvider | 'ESPN';

/** One external quote already mapped to the canonical market catalogue. */
export interface CanonicalProviderQuote {
  marketId: string;
  selectionKey: string;
  line?: number;
  decimalOdds: number;
  provider: ExternalOddsProvider;
  bookmaker: string;
  bookmakerKey: string;
  providerUpdatedAt?: Date;
  /** Vig-removed provider consensus fair price, where the market is complete. */
  marketFairOdds?: number;
}

export interface OddsProviderCacheResult<T> {
  data: T;
  fetchedAt: Date;
  fromCache: boolean;
}

export interface ProviderCollectionResult {
  pricesByEvent: Map<string, CanonicalProviderQuote[]>;
  updatedAtByEvent: Map<string, Date>;
  primaryAvailable: boolean;
  fallbackActive: boolean;
  statusMessage: string;
}

