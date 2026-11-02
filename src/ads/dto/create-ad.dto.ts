import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { AdAudience } from '../enums/ad-audience.enum';
import { AdType } from '../enums/ad-type.enum';
import { AdContentSource } from '../enums/ad-content-source.enum';
import { AdAutomationKey } from '../enums/ad-automation-key.enum';
import { CreateAdDisplayDto } from './create-ad-display.dto';
import { CreateAdImageDto } from './create-ad-image.dto';
import { CreateAdMediaDto } from './create-ad-media.dto';
import { CreateAdActionDto } from './create-ad-action.dto';
import { AdTargetingDto } from './ad-targeting.dto';
import type { AdAudienceVisibility } from '../interfaces/ad-content-visibility.interface';

export class CreateAdDto {
  @IsString() @MaxLength(150) title!: string;
  @IsOptional() @IsString() @MaxLength(150) subTitle?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) instructions?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => CreateAdImageDto)
  image?: CreateAdImageDto;
  @IsOptional()
  @ValidateNested()
  @Type(() => CreateAdMediaDto)
  media?: CreateAdMediaDto;
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateAdActionDto)
  actions?: CreateAdActionDto[];
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateAdDisplayDto)
  displays!: CreateAdDisplayDto[];

  @IsOptional() @IsEnum(AdType) type?: AdType;
  @IsOptional() @IsEnum(AdContentSource) contentSource?: AdContentSource;
  @IsOptional() @IsString() sourceId?: string;
  @IsOptional() @IsObject() contentVisibility?: AdAudienceVisibility;
  @IsOptional() @IsObject() design?: Record<string, unknown>;
  @IsOptional()
  @ValidateNested()
  @Type(() => AdTargetingDto)
  targeting?: AdTargetingDto;

  @IsOptional() @IsInt() @Min(1) @Max(10) priority?: number;
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined) return undefined;
    if (value === null || value === '') return [AdAudience.ALL];
    return Array.isArray(value)
      ? value.map((item: unknown) => item as AdAudience)
      : [value as AdAudience];
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsEnum(AdAudience, { each: true })
  audience?: AdAudience[];

  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsBoolean() automated?: boolean;
  @IsOptional() @IsEnum(AdAutomationKey) automationKey?: AdAutomationKey;
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  maxImpressionsPerVisitorPerDay?: number;
  @IsOptional() @IsDateString() startDate?: string | null;
  @IsOptional() @IsDateString() endDate?: string | null;
}
