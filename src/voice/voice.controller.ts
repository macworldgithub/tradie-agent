import { Body, Controller, Header, Post } from '@nestjs/common';
import { VoiceService } from './voice.service';

@Controller('voice')
export class VoiceController {
  constructor(private voiceService: VoiceService) {}

  @Post('incoming')
  @Header('Content-Type', 'application/xml')
  async incoming(@Body() body: Record<string, unknown>): Promise<string> {
    return this.voiceService.handleIncomingWebhook(body);
  }

  @Post('callback')
  @Header('Content-Type', 'application/xml')
  async callback(@Body() body: Record<string, unknown>): Promise<string> {
    return this.voiceService.handleCallbackWebhook(body);
  }
}
