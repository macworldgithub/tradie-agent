import { Controller } from '@nestjs/common';
import { VoiceService } from './voice.service';

@Controller('voice')
export class VoiceController {
  constructor(private voiceService: VoiceService) {}

  // The voice agent now operates entirely via WebSocket (Socket.IO gateway).
  // REST endpoints are no longer needed for the realtime flow.
  // Keeping this controller as a placeholder for potential future REST APIs.
}
