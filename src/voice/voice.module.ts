import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { VoiceController } from './voice.controller';
import { VoiceService } from './voice.service';
import { VoiceGateway } from './voice.gateway';
import { Customer, CustomerSchema } from './Schema/customer.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Customer.name, schema: CustomerSchema },
    ]),
  ],
  controllers: [VoiceController],
  providers: [VoiceService, VoiceGateway],
  exports: [VoiceService],
})
export class VoiceModule {}
