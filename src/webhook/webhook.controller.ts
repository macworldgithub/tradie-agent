import { Body, Controller, Header, Post, Query } from '@nestjs/common';
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
  ) {
    const res = await this.webhookService.handleIncoming(
      body as any,
      enfonicaCallId,
    );
    if (res.type === 'voiceml') {
      return res.body;
    }

    // For other cases, return a minimal XML ack
    return `<Response></Response>`;
  }
}
