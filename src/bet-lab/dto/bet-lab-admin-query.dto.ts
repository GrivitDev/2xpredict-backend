import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { BET_LAB_CONFIG } from '../config/bet-lab.config';

export class BetLabAdminEventsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit = BET_LAB_CONFIG.monitor.recentEventsLimit;
}
