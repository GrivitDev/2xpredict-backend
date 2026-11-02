import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class VerifyEmailChangeDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{6}$/, { message: 'Verification code must contain six digits.' })
  code!: string;
}
