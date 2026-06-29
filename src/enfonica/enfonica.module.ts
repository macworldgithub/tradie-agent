import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { EnfonicaService } from './enfonica.service';
import { EnfonicaController } from './enfonica.controller';
import { User, UserSchema } from '../auth/schemas/user.schema';
import { Did, DidSchema } from '../dids/schemas/did.schema';
import { Tradie, TradieSchema } from '../tradies/schemas/tradie.schema';
import { AdminModule } from '../admin/admin.module';
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Did.name, schema: DidSchema },
      { name: Tradie.name, schema: TradieSchema },
    ]),
    AdminModule,
  ],
  controllers: [EnfonicaController],
  providers: [EnfonicaService],
  exports: [EnfonicaService],
})
export class EnfonicaModule {}
