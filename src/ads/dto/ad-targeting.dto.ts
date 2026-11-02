import { IsArray, IsBoolean, IsIn, IsOptional } from 'class-validator';
import { AdAudience } from '../enums/ad-audience.enum';
import { AdAudienceKey } from '../interfaces/ad-content-visibility.interface';

const PLAN_AUDIENCES = [
  AdAudience.GUEST,
  AdAudience.FREE,
  AdAudience.REGULAR,
  AdAudience.VIP,
  AdAudience.PREMIUM,
];

export class AdTargetingDto {
  @IsOptional()
  @IsArray()
  @IsIn(PLAN_AUDIENCES, { each: true })
  allowedPlans?: AdAudienceKey[];
  @IsOptional()
  @IsArray()
  @IsIn(PLAN_AUDIENCES, { each: true })
  excludedPlans?: AdAudienceKey[];
  @IsOptional() @IsBoolean() requireAuthenticated?: boolean;
  @IsOptional() @IsBoolean() guestsOnly?: boolean;
}
