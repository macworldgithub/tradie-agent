import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CallLog, CallLogSchema } from './schemas/call-log.schema';
import { CallsService } from './calls.service';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: CallLog.name, schema: CallLogSchema }]),
  ],
  providers: [CallsService],
  exports: [CallsService],
})
export class CallsModule {}
