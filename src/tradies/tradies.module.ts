import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TradiesController } from './tradies.controller';
import { Tradie, TradieSchema } from './schemas/tradie.schema';
import { TradiesService } from './tradies.service';
import { Did, DidSchema } from '../dids/schemas/did.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Tradie.name, schema: TradieSchema },
      { name: Did.name, schema: DidSchema },
    ]),
  ],
  controllers: [TradiesController],
  providers: [TradiesService],
  exports: [TradiesService],
})
export class TradiesModule {}
