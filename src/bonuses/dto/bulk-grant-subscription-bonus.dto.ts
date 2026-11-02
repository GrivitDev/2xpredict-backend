import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

export type BonusRecipientPlan = 'free' | 'regular' | 'vip' | 'premium';

export class BulkGrantSubscriptionBonusDto {
  @IsIn(['regular', 'vip', 'premium'])
  plan!: 'regular' | 'vip' | 'premium';

  @IsInt()
  @Min(1)
  @Max(365)
  durationDays!: number;

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
  @IsDateString()
  startsAt?: string;

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
