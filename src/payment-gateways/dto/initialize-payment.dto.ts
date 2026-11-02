import { IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
export enum PaymentGateway { PAYSTACK = 'paystack' }
export enum PaymentType { SUBSCRIPTION = 'subscription', VIP_UPGRADE = 'vip_upgrade', PREMIUM_UPGRADE = 'premium_upgrade' }
export class InitializePaymentDto {
  @IsEnum(PaymentGateway) gateway!: PaymentGateway;
  @IsEnum(PaymentType) type!: PaymentType;
  @IsString() @IsNotEmpty() target!: string;
  @IsOptional() @IsString() @MaxLength(60) promoCode?: string;
}
