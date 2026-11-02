import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { AdDevice } from '../enums/ad-device.enum';
import { AdPage } from '../enums/ad-page.enum';
import { AdPosition } from '../enums/ad-position.enum';
import { AdTriggerEvent } from '../enums/ad-trigger-event.enum';

export class AdDeliveryQueryDto {
  @IsEnum(AdPage) page!: AdPage;
  @IsOptional() @IsEnum(AdDevice) device?: AdDevice;
  @IsOptional() @IsEnum(AdPosition) position?: AdPosition;
  @IsOptional() @IsEnum(AdTriggerEvent) triggerEvent?: AdTriggerEvent;
  @IsOptional() @IsString() @MaxLength(120) visitorKey?: string;
  @IsOptional() @IsString() @MaxLength(120) sessionKey?: string;
}
