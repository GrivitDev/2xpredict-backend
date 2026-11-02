import {
  IsInt,
  IsNotEmpty,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

export class GrantPointsBonusDto {
  @IsString()
  @IsNotEmpty()
  userId!: string;

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
}
