import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { AnalyticsVisitorType } from '../enums/analytics-visitor-type.enum';

export class TrackSessionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  visitorId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  sessionId!: string;

  @IsOptional()
  @IsEnum(AnalyticsVisitorType)
  visitorType?: AnalyticsVisitorType;

  @IsString()
  @MaxLength(40)
  timestamp!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(86400000)
  durationMs?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(86400000)
  activeTimeMs?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  path?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  landingPage?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  exitPage?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  pageViews?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  eventCount?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  bounced?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  deviceType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  browser?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  operatingSystem?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  screenWidth?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  screenHeight?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  referrer?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  utmSource?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  utmMedium?: string;

  @IsOptional()
  @IsString()
  @MaxLength(140)
  utmCampaign?: string;

  @IsOptional()
  @IsString()
  utmTerm?: string;

  @IsOptional()
  @IsString()
  utmContent?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  country?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  countryCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  region?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;
}

