import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class SendAdminSupportReplyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  message!: string;

  /** Makes retrying the same admin reply safe after a network timeout. */
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  clientMessageId?: string;
}
