import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  IsIn,
} from 'class-validator';

export type BonusRecipientPlan = 'free' | 'regular' | 'vip' | 'premium';

export class BulkGrantPointsBonusDto {
  @IsInt()
  @Min(1)
  @Max(1_000_000_000)
  points!: number;

  @IsString()
  @IsNotEmpty()
  @Matches(/\S/)
  @Length(3, 300)
  reason!: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/\S/)
  @Length(8, 120)
  idempotencyKey!: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsMongoId({ each: true })
  userIds?: string[];

  @IsOptional()
  @IsIn(['free', 'regular', 'vip', 'premium'])
  recipientPlan?: BonusRecipientPlan;
}
