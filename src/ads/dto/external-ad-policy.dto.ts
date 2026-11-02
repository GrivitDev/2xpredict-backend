import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { AdType } from '../enums/ad-type.enum';
import { ExternalAdFrequency } from '../enums/external-ad-frequency.enum';

export class ExternalAdPolicyDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsObject() audiences?: Record<string, boolean>;
  @IsOptional() @IsEnum(ExternalAdFrequency) frequency?: ExternalAdFrequency;
  @IsOptional() @IsInt() @Min(0) @Max(3600) refreshIntervalSeconds?: number;
  @IsOptional() @IsInt() @Min(0) @Max(20) maxImpressionsPerSession?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100) maxImpressionsPerDay?: number;
  @IsOptional() @IsObject() allowedTypes?: Partial<Record<AdType, boolean>>;
  @IsOptional() @IsBoolean() allowBanner?: boolean;
  @IsOptional() @IsBoolean() allowNative?: boolean;
  @IsOptional() @IsBoolean() allowInterstitial?: boolean;
  @IsOptional() @IsBoolean() allowPopup?: boolean;
  @IsOptional() @IsBoolean() allowRewarded?: boolean;
  @IsOptional() @IsBoolean() allowSticky?: boolean;
  @IsOptional() @IsBoolean() allowVideo?: boolean;
}
