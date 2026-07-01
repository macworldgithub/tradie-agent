import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PaymentsController, PaymentPagesController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { User, UserSchema } from '../auth/schemas/user.schema';
import { Did, DidSchema } from '../dids/schemas/did.schema';
import { ProcessedPayment, ProcessedPaymentSchema } from './schemas/processed-payment.schema';

import { AdminModule } from '../admin/admin.module';
import { EnfonicaModule } from '../enfonica/enfonica.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Did.name, schema: DidSchema },
      { name: ProcessedPayment.name, schema: ProcessedPaymentSchema }
    ]),
    AdminModule,
    EnfonicaModule,
  ],
  controllers: [PaymentsController, PaymentPagesController],
  providers: [PaymentsService]
})
export class PaymentsModule { }
