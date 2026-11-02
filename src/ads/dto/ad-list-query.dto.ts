import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { AdAudience } from '../enums/ad-audience.enum';
import { AdContentSource } from '../enums/ad-content-source.enum';
import { AdType } from '../enums/ad-type.enum';
import { AdPage } from '../enums/ad-page.enum';
import { AdPosition } from '../enums/ad-position.enum';
import { AdDevice } from '../enums/ad-device.enum';

export class AdListQueryDto {
  @IsOptional() @IsString() @MaxLength(150) search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === true || value === 'true'
      ? true
      : value === false || value === 'false'
        ? false
        : value,
  )
  @IsBoolean()
  active?: boolean;
  @IsOptional() @IsEnum(AdType) type?: AdType;
  @IsOptional() @IsEnum(AdContentSource) contentSource?: AdContentSource;
  @IsOptional() @IsEnum(AdAudience) audience?: AdAudience;
  @IsOptional() @IsEnum(AdPage) displayPage?: AdPage;
  @IsOptional() @IsEnum(AdPosition) position?: AdPosition;
  @IsOptional() @IsEnum(AdDevice) device?: AdDevice;
}
