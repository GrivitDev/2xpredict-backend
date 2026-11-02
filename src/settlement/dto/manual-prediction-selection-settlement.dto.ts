import { IsEnum, IsString, MaxLength, MinLength } from 'class-validator';
import { PredictionSettlementOutcome } from '../enums/settlement-prediction-outcome.enum';

/** Administrative override for one calculated Prediction Engine selection. */
export class ManualPredictionSelectionSettlementDto {
  @IsEnum(PredictionSettlementOutcome)
  outcome!: PredictionSettlementOutcome;

  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string;
}
