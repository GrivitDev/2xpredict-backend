import { IsNotEmpty, IsString, Length, Matches } from 'class-validator';

export class RevokeBonusDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/)
  @Length(3, 300)
  reason!: string;
}
