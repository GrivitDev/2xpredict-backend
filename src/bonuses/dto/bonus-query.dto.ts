import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsMongoId,
  IsNumber,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { BonusStatus } from '../enums/bonus-status.enum';
import { BonusType } from '../enums/bonus-type.enum';

export class BonusQueryDto {
  @IsOptional()
  @IsMongoId()
  userId?: string;

  @IsOptional()
  @IsEnum(BonusType)
  type?: BonusType;

  @IsOptional()
  @IsIn([...Object.values(BonusStatus), 'EXPIRED'])
  status?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(1)
  @Max(100)
  limit?: number;
}
