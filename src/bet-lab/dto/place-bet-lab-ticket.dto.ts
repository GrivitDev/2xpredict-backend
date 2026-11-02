import {
  IsEnum,
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { BET_LAB_CONFIG } from '../config/bet-lab.config';
import { BetLabMarketCode } from '../enums/bet-lab-market-code.enum';

export class PlaceBetLabTicketDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  eventId!: string;

  @IsEnum(BetLabMarketCode)
  marketCode!: BetLabMarketCode;

  @IsString()
  @MinLength(1)
  @MaxLength(160)
  selectionCode!: string;

  @IsInt()
  @Min(BET_LAB_CONFIG.virtualPoints.minimumStake)
  @Max(BET_LAB_CONFIG.virtualPoints.maximumStake)
  stake!: number;

  /** Stable client-generated value reused for retries of the same placement request. */
  @IsString()
  @MinLength(8)
  @MaxLength(120)
  @Matches(/^[a-zA-Z0-9:_-]+$/)
  idempotencyKey!: string;
}
