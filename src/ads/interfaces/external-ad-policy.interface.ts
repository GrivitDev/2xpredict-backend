import { AdType } from '../enums/ad-type.enum';
import { ExternalAdFrequency } from '../enums/external-ad-frequency.enum';

export type ExternalAdTypePermissions = Record<AdType, boolean>;

export interface ExternalAdPolicy {
  enabled: boolean;
  audiences: Record<'GUEST' | 'FREE' | 'REGULAR' | 'VIP' | 'PREMIUM', boolean>;
  frequency: ExternalAdFrequency;
  refreshIntervalSeconds: number;
  maxImpressionsPerSession: number;
  maxImpressionsPerDay: number;
  allowedTypes: ExternalAdTypePermissions;
}

export interface AdPolicyResponse {
  external: ExternalAdPolicy & {
    enabledForCurrentAudience: boolean;
    audience: string;
  };
}
