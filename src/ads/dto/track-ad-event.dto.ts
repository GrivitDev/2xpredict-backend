import {
  IsEnum,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { AdEventType } from '../enums/ad-event-type.enum';
import { AdPage } from '../enums/ad-page.enum';
import { AdPosition } from '../enums/ad-position.enum';
import { AdDevice } from '../enums/ad-device.enum';

export class TrackAdEventDto {
  @IsEnum(AdEventType) type!: AdEventType;
  @IsString() @MaxLength(120) eventKey!: string;
  @IsOptional() @IsString() @MaxLength(120) visitorKey?: string;
  @IsOptional() @IsString() @MaxLength(120) sessionKey?: string;
  @IsOptional() @IsString() @MaxLength(100) placement?: string;
  @IsOptional() @IsEnum(AdPage) page?: AdPage;
  @IsOptional() @IsEnum(AdPosition) position?: AdPosition;
  @IsOptional() @IsEnum(AdDevice) device?: AdDevice;
  @IsOptional() @IsString() @MaxLength(80) conversionType?: string;
  @IsOptional() @IsNumber() @Min(0) conversionValue?: number;
  @IsOptional() @IsIn(['NGN', 'USD']) currency?: 'NGN' | 'USD';
  @IsOptional() @IsObject() metadata?: Record<string, unknown>;
}
