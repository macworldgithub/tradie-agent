import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Did, DidSchema } from './schemas/did.schema';
import { DidsService } from './dids.service';

@Module({
  imports: [MongooseModule.forFeature([{ name: Did.name, schema: DidSchema }])],
  providers: [DidsService],
  exports: [DidsService],
})
export class DidsModule {}
