import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AriController } from './ari.controller';
import { AriService } from './ari.service';
import { AriRtpMediaService } from './ari-rtp-media.service';
import { AriWebSocketGateway } from './ari-websocket.gateway';
import { VoiceAgentModule } from '../voice-agent/voice-agent.module';

@Module({
  imports: [ConfigModule, VoiceAgentModule],
  controllers: [AriController],
  providers: [AriService, AriRtpMediaService, AriWebSocketGateway],
  exports: [AriService, AriRtpMediaService, AriWebSocketGateway],
})
export class AriModule {}
