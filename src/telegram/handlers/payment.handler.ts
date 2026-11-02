import { Injectable } from '@nestjs/common';

@Injectable()
export class PaymentHandler {
  buildPaymentMessage(data: {
    fullName: string;
    email: string;
    type: string;
    amount: number;
    currency: string;
    target: string;
  }) {
    const symbol = data.currency === 'USD' ? '$' : '₦';
    const paymentTypeLabel =
      data.type === 'subscription'
        ? `${data.target.toUpperCase()} Subscription`
        : data.type === 'vip_upgrade'
          ? 'VIP Upgrade'
          : data.type === 'premium_upgrade'
            ? 'Premium Upgrade'
            : data.type;

    return `
💰 NEW PAYMENT

User: ${data.fullName}
Email: ${data.email}

Type: ${paymentTypeLabel}
Amount: ${symbol}${data.amount.toLocaleString()}

Target: ${data.target}
`;
  }
}
