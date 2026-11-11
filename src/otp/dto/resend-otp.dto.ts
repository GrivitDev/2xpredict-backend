import { IsEmail, MaxLength } from 'class-validator';

export class ResendOtpDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;
}
