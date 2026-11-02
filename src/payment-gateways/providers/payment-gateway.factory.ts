import { BadRequestException, Injectable } from '@nestjs/common';
import type { PaymentGateway } from '../interfaces/payment-gateway.interface';
import { PaystackProvider } from './paystack.provider';

/** Only Paystack is supported by the current production configuration. */
@Injectable()
export class PaymentGatewayFactory {
  constructor(private readonly paystackProvider: PaystackProvider) {}

  create(gateway: string): PaymentGateway {
    if (gateway !== 'paystack') {
      throw new BadRequestException(`Unsupported payment gateway: ${String(gateway)}`);
    }
    return this.paystackProvider;
  }
}
