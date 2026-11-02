import { Type } from 'class-transformer';
import {
  IsDefined,
  IsInt,
  IsObject,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

const MAX_VIRTUAL_POINTS = Number.MAX_SAFE_INTEGER;

export class BetLabMonthlyAllowanceByPlanDto {
  @IsDefined()
  @IsInt()
  @Min(0)
  @Max(MAX_VIRTUAL_POINTS)
  free!: number;

  @IsDefined()
  @IsInt()
  @Min(0)
  @Max(MAX_VIRTUAL_POINTS)
  regular!: number;

  @IsDefined()
  @IsInt()
  @Min(0)
  @Max(MAX_VIRTUAL_POINTS)
  vip!: number;

  @IsDefined()
  @IsInt()
  @Min(0)
  @Max(MAX_VIRTUAL_POINTS)
  premium!: number;
}

export class UpdateBetLabVirtualPointsSettingsDto {
  @IsDefined()
  @IsInt()
  @Min(0)
  @Max(MAX_VIRTUAL_POINTS)
  registrationBonus!: number;

  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => BetLabMonthlyAllowanceByPlanDto)
  monthlyAllowanceByPlan!: BetLabMonthlyAllowanceByPlanDto;
}
