import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { Type } from 'class-transformer';

import { AnalyticsEventType } from '../enums/analytics-event-type.enum';

export class TrackEventDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  visitorId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  sessionId!: string;

  @IsEnum(AnalyticsEventType)
  eventType!: AnalyticsEventType;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  eventName!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  path!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  pageTitle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  url?: string;

  @IsOptional()
  @IsObject()
  properties?: Record<string, unknown>;

  @IsString()
  @MaxLength(40)
  occurredAt!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(86400000)
  durationMs?: number;

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

  @IsOptional()
  @IsString()
  @MaxLength(250)
  userAgent?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  eventId!: string;
}

export class TrackEventsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => TrackEventDto)
  events!: TrackEventDto[];
}

