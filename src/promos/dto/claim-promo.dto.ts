import { IsString, MaxLength, MinLength } from 'class-validator';
export class ClaimPromoDto {
  @IsString() @MinLength(1) @MaxLength(60) promoCode!: string;
}
