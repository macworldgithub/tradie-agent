import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { VoiceModule } from './voice/voice.module';
import { AuthModule } from './auth/auth.module';
import { AriModule } from './ari/ari.module';
import { Customer, CustomerSchema } from './voice/Schema/customer.schema';
import { DidsModule } from './dids/dids.module';
import { TradiesModule } from './tradies/tradies.module';
import { CallsModule } from './calls/calls.module';
import { WebhookModule } from './webhook/webhook.module';
import { SmsTestModule } from './sms-test/sms-test.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.get<string>('MONGO_URI'),
      }),
    }),
    MongooseModule.forFeature([
      {
        name: Customer.name,
        schema: CustomerSchema,
      },
    ]),
    VoiceModule,
    AuthModule,
    AriModule,
    DidsModule,
    TradiesModule,
    CallsModule,
    WebhookModule,
    SmsTestModule,
  ],
})
export class AppModule {}
