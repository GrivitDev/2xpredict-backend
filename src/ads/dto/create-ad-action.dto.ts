import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

export class CreateAdActionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  label!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  @Matches(/^(\/[a-zA-Z0-9\-_/?.=&%]*|https?:\/\/[^\s]+)$/i, {
    message: 'URL must be an internal route or an HTTP(S) URL.',
  })
  url!: string;
}
