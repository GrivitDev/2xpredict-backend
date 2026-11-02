import { IsEmail, IsNotEmpty, IsString, MinLength, MaxLength } from 'class-validator';

export class RequestEmailChangeDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(6)
  @MaxLength(128)
  currentPassword!: string;

  @IsEmail()
  @MaxLength(254)
  newEmail!: string;
}
