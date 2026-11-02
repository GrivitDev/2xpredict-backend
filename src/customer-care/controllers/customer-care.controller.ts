import { Body, Controller, Get, Headers, Param, Post, Query, UseGuards } from '@nestjs/common';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CustomerCareService } from '../services/customer-care.service';
import { SendSupportMessageDto } from '../dto/send-support-message.dto';

@Controller('customer-care')
@UseGuards(JwtAuthGuard)
export class CustomerCareController {
  constructor(private readonly customerCare: CustomerCareService) {}

  @Post('message')
  sendMessage(
    @GetUser() user: { _id?: unknown },
    @Body() body: SendSupportMessageDto,
    @Headers('idempotency-key') idempotencyHeader?: string,
  ) {
    const requestId = body.clientMessageId || idempotencyHeader;
    return this.customerCare.sendMessage(
      String(user?._id ?? ''), body.message, body.conversationId, requestId,
    );
  }

  @Get('notifications/summary')
  getNotificationSummary(@GetUser() user: { _id?: unknown }) {
    return this.customerCare.getCustomerNotificationSummary(String(user?._id ?? ''));
  }

  @Post('conversations/:id/read')
  markConversationRead(@GetUser() user: { _id?: unknown }, @Param('id') id: string) {
    return this.customerCare.markCustomerConversationRead(String(user?._id ?? ''), id);
  }

  @Get('conversations')
  getMyConversations(@GetUser() user: { _id?: unknown }, @Query('limit') limit?: string) {
    return this.customerCare.getMyConversations(String(user?._id ?? ''), Number(limit) || 20);
  }

  @Get('messages/:id/status')
  getMessageStatus(@GetUser() user: { _id?: unknown }, @Param('id') id: string) {
    return this.customerCare.getMessageStatus(String(user?._id ?? ''), id);
  }

  @Get('conversations/:id')
  getConversation(@GetUser() user: { _id?: unknown }, @Param('id') id: string) {
    return this.customerCare.getConversation(String(user?._id ?? ''), id);
  }

  @Post('conversations/:id/close')
  closeConversation(@GetUser() user: { _id?: unknown }, @Param('id') id: string) {
    return this.customerCare.closeConversation(String(user?._id ?? ''), id);
  }
}
