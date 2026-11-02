import { IsInt, IsString, IsUrl, Min } from 'class-validator';

export class CreateAdImageDto {
  @IsUrl({ protocols: ['https'], require_protocol: true }) url!: string;
  @IsString() publicId!: string;
  @IsInt() @Min(1) width!: number;
  @IsInt() @Min(1) height!: number;
  @IsString() format!: string;
  @IsInt() @Min(0) bytes!: number;
}
