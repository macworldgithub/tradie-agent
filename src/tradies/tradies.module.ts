import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Tradie, TradieSchema } from './schemas/tradie.schema';
import { TradiesService } from './tradies.service';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Tradie.name, schema: TradieSchema }]),
  ],
  providers: [TradiesService],
  exports: [TradiesService],
})
export class TradiesModule {}
