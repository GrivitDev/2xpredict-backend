import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { SettlementJobStatus } from '../enums/settlement-job-status.enum';

export class SettlementJobQueryDto {
  @IsOptional()
  @IsEnum(SettlementJobStatus)
  status?: SettlementJobStatus;

  @IsOptional()
  @IsString()
  eventId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit = 50;
}

