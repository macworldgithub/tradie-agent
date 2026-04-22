import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CallService } from './call.service';
import { CallController } from './call.controller';
import { Call, CallSchema } from './schemas/call.schema';
import { TradieModule } from '../tradie/tradie.module';
import { PbxModule } from '../pbx/pbx.module';
import { LeadModule } from '../lead/lead.module';
import { NotificationModule } from '../notification/notification.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Call.name, schema: CallSchema }]),
    TradieModule,
    forwardRef(() => PbxModule),
    LeadModule,
    NotificationModule,
  ],
  controllers: [CallController],
  providers: [CallService],
  exports: [CallService],
})
export class CallModule {}
