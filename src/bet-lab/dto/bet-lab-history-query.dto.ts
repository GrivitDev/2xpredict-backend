import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { BET_LAB_CONFIG } from '../config/bet-lab.config';
import { BetLabTicketStatus } from '../enums/bet-lab-ticket-status.enum';

export class BetLabHistoryQueryDto {
  @IsOptional()
  @IsEnum(BetLabTicketStatus)
  status?: BetLabTicketStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(BET_LAB_CONFIG.monitor.maximumHistoryPageSize)
  limit = BET_LAB_CONFIG.monitor.defaultHistoryPageSize;
}

export class BetLabLedgerQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(BET_LAB_CONFIG.monitor.maximumHistoryPageSize)
  limit = BET_LAB_CONFIG.monitor.defaultHistoryPageSize;
}
