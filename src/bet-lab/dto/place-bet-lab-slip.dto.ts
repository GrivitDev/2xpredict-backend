import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { BET_LAB_CONFIG } from '../config/bet-lab.config';
import { BetLabMarketCode } from '../enums/bet-lab-market-code.enum';
import { BET_LAB_ACTIVE_MARKET_CODES } from '../catalog/bet-lab-market-catalog';

export class BetLabSlipLegDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @Matches(/\S/, { message: 'eventId must not be blank.' })
  eventId!: string;

  // Validate against the live catalogue, not the wider legacy enum.
  @IsIn([...BET_LAB_ACTIVE_MARKET_CODES])
  marketCode!: BetLabMarketCode;

  @IsString()
  @MinLength(1)
  @MaxLength(160)
  @Matches(/\S/, { message: 'selectionCode must not be blank.' })
  selectionCode!: string;
}

export class PlaceBetLabSlipDto {
  @IsArray()
  @ArrayMinSize(BET_LAB_CONFIG.tickets.minimumAccumulatorLegs)
  @ValidateNested({ each: true })
  @Type(() => BetLabSlipLegDto)
  legs!: BetLabSlipLegDto[];

  @IsInt()
  @Min(BET_LAB_CONFIG.virtualPoints.minimumStake)
  @Max(BET_LAB_CONFIG.virtualPoints.maximumStake)
  stake!: number;

  @IsString()
  @MinLength(8)
  @MaxLength(120)
  @Matches(/^[a-zA-Z0-9:_-]+$/)
  idempotencyKey!: string;
}


