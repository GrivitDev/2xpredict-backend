import {
  IsIn,
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
import { BET_LAB_ACTIVE_MARKET_CODES } from '../catalog/bet-lab-market-catalog';

export class PlaceBetLabTicketDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @Matches(/\S/, { message: 'eventId must not be blank.' })
  eventId!: string;

  // The enum intentionally retains legacy values for historical ticket documents.
  // New placements are restricted to the 16 active Odds-catalogue markets.
  @IsIn([...BET_LAB_ACTIVE_MARKET_CODES])
  marketCode!: BetLabMarketCode;

  @IsString()
  @MinLength(1)
  @MaxLength(160)
  @Matches(/\S/, { message: 'selectionCode must not be blank.' })
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

