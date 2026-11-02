import { IsBoolean, IsOptional } from 'class-validator';

/** Required when an earlier Telegram send may already have reached the channel. */
export class RetryCustomerCareBroadcastDto {
  @IsOptional()
  @IsBoolean()
  confirmNotPosted?: boolean;
}
