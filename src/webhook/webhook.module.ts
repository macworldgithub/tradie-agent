import { Module } from '@nestjs/common';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { DidsModule } from '../dids/dids.module';
import { TradiesModule } from '../tradies/tradies.module';
import { CallsModule } from '../calls/calls.module';
import { AriModule } from '../ari/ari.module';

@Module({
  imports: [DidsModule, TradiesModule, CallsModule, AriModule],
  controllers: [WebhookController],
  providers: [WebhookService],
})
export class WebhookModule {}
