import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
} from 'class-validator';
import { AdMediaType } from '../schemas/ad-media.schema';

export class CreateAdMediaDto {
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true }) url!: string;
  @IsEnum(AdMediaType) type!: AdMediaType;
  @IsOptional() @IsString() publicId?: string;
  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  posterUrl?: string;
  @IsOptional() @IsString() mimeType?: string;
  @IsOptional() @IsInt() @Min(0) @Max(3600) durationSeconds?: number;
  @IsOptional() @IsBoolean() autoplay?: boolean;
  @IsOptional() @IsBoolean() muted?: boolean;
  @IsOptional() @IsBoolean() loop?: boolean;
}
