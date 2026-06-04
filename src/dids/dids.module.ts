import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DidsController } from './dids.controller';
import { Did, DidSchema } from './schemas/did.schema';
import { DidsService } from './dids.service';
import { Tradie, TradieSchema } from '../tradies/schemas/tradie.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Did.name, schema: DidSchema },
      { name: Tradie.name, schema: TradieSchema },
    ]),
  ],
  controllers: [DidsController],
  providers: [DidsService],
  exports: [DidsService],
})
export class DidsModule {}
