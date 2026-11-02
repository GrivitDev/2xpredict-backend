import { IsMongoId, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class SendSupportMessageDto {
  @IsOptional()
  @IsMongoId()
  conversationId?: string;

  /** Generate a UUID per user send and reuse it if retrying that HTTP request. */
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  clientMessageId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  message!: string;
}
