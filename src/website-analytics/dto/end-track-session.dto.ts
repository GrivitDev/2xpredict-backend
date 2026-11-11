import {
  IsBoolean,
  IsISO8601,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Validated payload for the public, idempotent session-end endpoint. */
export class EndTrackSessionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  sessionId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  visitorId?: string;

  @IsOptional()
  @IsISO8601()
  timestamp?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  path?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(86_400_000)
  durationMs?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(86_400_000)
  activeTimeMs?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000)
  pageViews?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000)
  eventCount?: number;

  @IsOptional()
  @IsBoolean()
  bounced?: boolean;
}
