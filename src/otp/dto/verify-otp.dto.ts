import { IsEmail, Matches, MaxLength } from 'class-validator';

export class VerifyOtpDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @Matches(/^\d{6}$/, {
    message: 'Verification code must contain exactly six digits.',
  })
  code!: string;
}
