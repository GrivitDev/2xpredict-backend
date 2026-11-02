import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { SettlementEventLevel } from '../enums/settlement-event-level.enum';

export class SettlementEventQueryDto {
  @IsOptional()
  @IsEnum(SettlementEventLevel)
  level?: SettlementEventLevel;

  @IsOptional()
  @IsString()
  eventId?: string;

  @IsOptional()
  @IsString()
  action?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit = 100;
}

