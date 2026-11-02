import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { AdEventType } from '../enums/ad-event-type.enum';
import { AdAudience } from '../enums/ad-audience.enum';
import { AdDevice } from '../enums/ad-device.enum';
import { AdPage } from '../enums/ad-page.enum';
import { AdPosition } from '../enums/ad-position.enum';

export class AdEventQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 25;
  @IsOptional() @IsEnum(AdEventType) type?: AdEventType;
  @IsOptional() @IsEnum(AdAudience) audience?: AdAudience;
  @IsOptional() @IsEnum(AdPage) adPage?: AdPage;
  @IsOptional() @IsEnum(AdPosition) position?: AdPosition;
  @IsOptional() @IsEnum(AdDevice) device?: AdDevice;
  @IsOptional() @IsString() adId?: string;
  @IsOptional() @IsDateString() startDate?: string;
  @IsOptional() @IsDateString() endDate?: string;
  @IsOptional() @IsString() @MaxLength(80) conversionType?: string;
}
