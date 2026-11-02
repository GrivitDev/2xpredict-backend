import { IsEnum, IsString, MaxLength, MinLength } from 'class-validator';
import { SettlementOutcome } from '../enums/settlement-outcome.enum';

export class ManualBetLabLegSettlementDto {
  @IsEnum(SettlementOutcome)
  outcome!: SettlementOutcome;

  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string;
}

