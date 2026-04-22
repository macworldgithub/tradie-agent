import { Module, forwardRef } from '@nestjs/common';
import { VoiceAgentController } from './voice-agent.controller';
import { VoiceAgentService } from './voice-agent.service';
import { TradieModule } from '../tradie/tradie.module';
import { CallModule } from '../call/call.module';

@Module({
  imports: [
    TradieModule,
    forwardRef(() => CallModule),
  ],
  controllers: [VoiceAgentController],
  providers: [VoiceAgentService],
  exports: [VoiceAgentService],
})
export class VoiceAgentModule {}
