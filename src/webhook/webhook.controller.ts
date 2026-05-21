import { Body, Controller, Header, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { WebhookService } from './webhook.service';
import { WebhookCallDto } from './dtos/webhook-call.dto';

@Controller('webhook')
export class WebhookController {
  constructor(private readonly webhookService: WebhookService) {}

  @Post('call')
  @Header('Content-Type', 'application/xml')
  async handleCall(
    @Body() body: WebhookCallDto,
    @Query('enfonicaCallId') enfonicaCallId?: string,
    @Req() req?: any,
  ) {
    console.log('=== RAW HEADERS ===');
    console.log(JSON.stringify(req?.headers));
    console.log('=== RAW BODY ===');
    console.log(JSON.stringify(req?.body));

    const res = await this.webhookService.handleIncoming(
      body as any,
      enfonicaCallId,
    );

    if (res.type === 'voiceml') {
      return res.body;
    }

    return `<Response></Response>`;
  }
}
