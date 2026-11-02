import {
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

export class GrantSubscriptionBonusDto {
  @IsString()
  @IsNotEmpty()
  userId!: string;

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
}
