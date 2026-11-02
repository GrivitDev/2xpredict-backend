import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
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

export class BetLabSlipLegDto {
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
}

export class PlaceBetLabSlipDto {
  @IsArray()
  @ArrayMinSize(BET_LAB_CONFIG.tickets.minimumAccumulatorLegs)
  @ArrayMaxSize(BET_LAB_CONFIG.tickets.maximumAccumulatorLegs)
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
