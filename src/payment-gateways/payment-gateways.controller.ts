import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { EmailVerifiedGuard } from '../common/guards/email-verified.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { GetUser } from '../common/decorators/get-user.decorator';
import { PaymentGatewaysService } from './payment-gateways.service';
import { InitializePaymentDto } from './dto/initialize-payment.dto';

@Controller('payment-gateways')
export class PaymentGatewaysController {
  constructor(private readonly paymentGatewaysService: PaymentGatewaysService) {}

  @UseGuards(JwtAuthGuard)
  @Post('quote')
  quotePayment(
    @GetUser() user: { _id: string },
    @Body() body: { type: 'subscription' | 'vip_upgrade' | 'premium_upgrade'; target: string; promoCode?: string },
  ) {
    return this.paymentGatewaysService.quotePayment({
      userId: user._id, type: body.type, target: body.target, promoCode: body.promoCode,
    });
  }

  @UseGuards(JwtAuthGuard, EmailVerifiedGuard)
  @Post('initialize')
  initializePayment(
    @GetUser() user: { _id: string; email: string },
    @Body() body: InitializePaymentDto,
  ) {
    return this.paymentGatewaysService.initializePayment({
      userId: user._id,
      email: user.email,
      gateway: 'paystack',
      type: body.type,
      target: body.target,
      promoCode: body.promoCode,
    });
  }

  @Get('paystack/initialization/:reference')
  @UseGuards(JwtAuthGuard)
  getInitialization(
    @GetUser() user: { _id: string },
    @Param('reference') reference: string,
  ) {
    if (!reference || reference.length > 120) {
      throw new BadRequestException('A valid payment reference is required.');
    }
    return this.paymentGatewaysService.getInitialization(reference, user._id);
  }

  @Get('paystack/verify')
  @UseGuards(JwtAuthGuard)
  verifyPayment(
    @GetUser() user: { _id: string },
    @Query('reference') reference: string,
  ) {
    if (!reference || reference.length > 120) {
      throw new BadRequestException('A valid payment reference is required.');
    }
    return this.paymentGatewaysService.verifyPayment('paystack', reference, user._id);
  }

  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Patch('paystack/reconcile/:reference')
  reconcilePayment(@Param('reference') reference: string) {
    if (!reference || reference.length > 120) {
      throw new BadRequestException('A valid payment reference is required.');
    }
    return this.paymentGatewaysService.reconcilePayment(reference);
  }

  @Post('paystack/webhook')
  paystackWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-paystack-signature') signature?: string,
  ) {
    return this.paymentGatewaysService.handleWebhook(
      req.body as unknown,
      signature,
      req.rawBody,
    );
  }
}

