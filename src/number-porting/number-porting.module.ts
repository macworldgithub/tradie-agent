import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { NumberPorting, NumberPortingSchema } from './schemas/number-porting.schema';
import { NumberPortingService } from './number-porting.service';
import { NumberPortingController } from './number-porting.controller';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: NumberPorting.name, schema: NumberPortingSchema }])
  ],
  controllers: [NumberPortingController],
  providers: [NumberPortingService],
  exports: [NumberPortingService, MongooseModule],
})
export class NumberPortingModule {}
