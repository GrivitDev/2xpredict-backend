import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { AdDevice } from '../enums/ad-device.enum';
import { AdPage } from '../enums/ad-page.enum';
import { AdPosition } from '../enums/ad-position.enum';
import { AdTrigger } from '../enums/ad-trigger.enum';

export class CreateAdDisplayDto {
  @IsEnum(AdPage) page!: AdPage;
  @IsEnum(AdPosition) position!: AdPosition;
  @IsOptional() @IsEnum(AdTrigger) trigger: AdTrigger = AdTrigger.ALWAYS;
  @IsOptional() @IsEnum(AdDevice) device: AdDevice = AdDevice.ALL;
  @IsOptional() @IsBoolean() fixed = false;
  @IsOptional() @IsInt() @Min(1) displayOrder = 1;
  @IsOptional() @IsInt() @Min(0) @Max(4000) width?: number;
  @IsOptional() @IsInt() @Min(0) @Max(4000) height?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100) widthPercent?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100) maxWidthPercent?: number;
  @IsOptional() @IsInt() @Min(0) @Max(4000) maxWidth?: number;
  @IsOptional() @IsInt() @Min(0) @Max(4000) maxHeight?: number;
  @IsOptional() @IsString() aspectRatio?: string;
  @IsOptional() @IsIn(['contain', 'cover', 'fill']) objectFit?:
    | 'contain'
    | 'cover'
    | 'fill';
}
