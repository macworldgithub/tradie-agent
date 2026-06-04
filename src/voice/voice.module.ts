import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { VoiceController } from './voice.controller';
import { VoiceService } from './voice.service';
import { VoiceGateway } from './voice.gateway';
import { Customer, CustomerSchema } from './Schema/customer.schema';
import { DidsModule } from '../dids/dids.module';
import { TradiesModule } from '../tradies/tradies.module';
import { SessionService } from '../session/session.service';
import { CallsModule } from '../calls/calls.module';
import { CommonModule } from '../common/common.module';
import { AriModule } from '../ari/ari.module';
import { CallEventEmitter } from './call-event-emitter';
import { CallEventsHandler } from './call-events.handler';
import { EmailWorkerService } from './email-worker.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Customer.name, schema: CustomerSchema },
    ]),
    DidsModule,
    TradiesModule,
    CallsModule,
    CommonModule,
    forwardRef(() => AriModule),
  ],
  controllers: [VoiceController],
  providers: [
    VoiceService,
    VoiceGateway,
    SessionService,
    CallEventEmitter,
    CallEventsHandler,
    EmailWorkerService,
  ],
  exports: [VoiceService, CallEventEmitter],
})
export class VoiceModule {}
