import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { VoiceModule } from './voice/voice.module';
import { AuthModule } from './auth/auth.module';
import { TradieModule } from './tradie/tradie.module';
import { LeadModule } from './lead/lead.module';
import { CallModule } from './call/call.module';
import { PbxModule } from './pbx/pbx.module';
import { NotificationModule } from './notification/notification.module';
import { VoiceAgentModule } from './voice-agent/voice-agent.module';
import { AriModule } from './ari/ari.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.get('MONGO_URI'),
      }),
    }),
    VoiceModule,
    AuthModule,
    TradieModule,
    LeadModule,
    CallModule,
    PbxModule,
    NotificationModule,
    VoiceAgentModule,
    AriModule,
  ],
})
export class AppModule {}
