import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';

import { PaymentsService } from './payments.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { EmailVerifiedGuard } from '../common/guards/email-verified.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { GetUser } from '../common/decorators/get-user.decorator';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @UseGuards(JwtAuthGuard, EmailVerifiedGuard)
  @Post()
  create(
    @GetUser() user: { _id: string; email: string },

    @Body()
    body: {
      type: 'subscription' | 'vip_upgrade' | 'premium_upgrade';

      target: string;

      transferReference?: string;

      proofImageUrl?: string;

      proofPublicId?: string;

      proofMessage?: string;
      promoCode?: string;
    },
  ) {
    return this.paymentsService.createPayment({
      userId: user._id,
      email: user.email,

      type: body.type,
      target: body.target,

      transferReference: body.transferReference,

      proofImageUrl: body.proofImageUrl,

      proofPublicId: body.proofPublicId,

      proofMessage: body.proofMessage,
      promoCode: body.promoCode,
    });
  }
  @UseGuards(JwtAuthGuard)
  @Get('me')
  getMyPayments(@GetUser() user: { _id: string }) {
    return this.paymentsService.getUserPayments(user._id);
  }
  // =========================
  // ADMIN APPROVE
  // =========================
  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Patch(':id/approve')
  approve(@Param('id') id: string, @GetUser() admin: { _id: string }) {
    return this.paymentsService.approvePayment(id, admin._id);
  }

  // =========================
  // ADMIN REJECT
  // =========================
  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Patch(':id/reject')
  reject(@Param('id') id: string, @GetUser() admin: { _id: string }) {
    return this.paymentsService.rejectPayment(id, admin._id);
  }

  // =========================
  // ADMIN VIEWS
  // =========================
  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get('pending')
  pending() {
    return this.paymentsService.getPendingPayments();
  }

  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get()
  all() {
    return this.paymentsService.getAllPayments();
  }
}
