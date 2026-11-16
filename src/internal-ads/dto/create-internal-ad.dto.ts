import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { DisplayLevel } from '../enums/display-level.enum';
import { InternalAdPlacement } from '../enums/internal-ad-placement.enum';

class AdActionDto {
  @IsString()
  @MaxLength(64)
  label!: string;

  @IsString()
  @MaxLength(2048)
  url!: string;
}

export class CreateInternalAdDto {
  @IsString()
  @MaxLength(120)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(180)
  subtitle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1200)
  message?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  description?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  instructions?: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AdActionDto)
  actions?: AdActionDto[];

  @IsOptional()
  @IsString()
  image?: string;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsEnum(InternalAdPlacement, { each: true })
  placements?: InternalAdPlacement[];

  @IsOptional()
  @IsEnum(DisplayLevel)
  displayLevel?: DisplayLevel;

  @IsOptional()
  @IsNumber()
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsDateString()
  startDate?: Date;

  @IsOptional()
  @IsDateString()
  endDate?: Date;
}
