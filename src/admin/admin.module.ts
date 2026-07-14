import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { User, UserSchema } from '../auth/schemas/user.schema';
import { Did, DidSchema } from '../dids/schemas/did.schema';
import { Tradie, TradieSchema } from '../tradies/schemas/tradie.schema';
import { TradiesModule } from '../tradies/tradies.module';
import { DidsModule } from '../dids/dids.module';
import { NumberPortingModule } from '../number-porting/number-porting.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Did.name, schema: DidSchema },
      { name: Tradie.name, schema: TradieSchema },
    ]),
    TradiesModule,
    DidsModule,
    NumberPortingModule,
  ],
  controllers: [AdminController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
