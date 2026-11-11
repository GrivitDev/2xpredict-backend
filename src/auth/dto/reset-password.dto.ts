import { IsEmail, IsString, Matches, MaxLength } from 'class-validator';
import {
  PASSWORD_POLICY_MESSAGE,
  PASSWORD_POLICY_PATTERN,
} from '../password-policy.util';

export class ResetPasswordDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @Matches(/^[a-fA-F0-9]{64}$/, {
    message: 'The password reset token is invalid.',
  })
  token!: string;

  @IsString()
  @Matches(PASSWORD_POLICY_PATTERN, { message: PASSWORD_POLICY_MESSAGE })
  @MaxLength(72)
  newPassword!: string;
}
