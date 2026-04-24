import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AriController } from './ari.controller';
import { AriService } from './ari.service';
import { VoiceAgentModule } from '../voice-agent/voice-agent.module';

@Module({
  imports: [ConfigModule, VoiceAgentModule],
  controllers: [AriController],
  providers: [AriService],
  exports: [AriService],
})
export class AriModule {}
