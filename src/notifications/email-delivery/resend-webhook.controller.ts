import { Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ResendWebhookService } from './resend-webhook.service';

type RequestWithRawBody = Request & { rawBody?: Buffer };

@Controller('webhooks/resend')
export class ResendWebhookController {
  constructor(private readonly resendWebhookService: ResendWebhookService) {}
  @Post()
  @HttpCode(HttpStatus.OK)
  receive(@Req() request: RequestWithRawBody) {
    return this.resendWebhookService.receive(request.rawBody, {
      id: request.headers['svix-id'] as string | undefined,
      timestamp: request.headers['svix-timestamp'] as string | undefined,
      signature: request.headers['svix-signature'] as string | undefined,
    });
  }
}
