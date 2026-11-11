import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  IsOptional,
} from 'class-validator';
import {
  PASSWORD_POLICY_MESSAGE,
  PASSWORD_POLICY_PATTERN,
} from '../password-policy.util';

export class RegisterDto {
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(100)
  fullName!: string;

  @IsString()
  @Matches(/^[a-zA-Z0-9_]{3,24}$/, {
    message: 'Username must be 3–24 characters and contain only letters, numbers and underscores.',
  })
  username!: string;

  @IsString()
  @MaxLength(30)
  @Matches(/^[+0-9()\-\s]*$/, {
    message: 'Phone number contains unsupported characters.',
  })
  phoneNumber!: string;

  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @Matches(PASSWORD_POLICY_PATTERN, { message: PASSWORD_POLICY_MESSAGE })
  @MaxLength(72)
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  referralCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  promoCode?: string;
}
