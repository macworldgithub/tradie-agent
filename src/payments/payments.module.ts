import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PaymentsController, PaymentPagesController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { User, UserSchema } from '../auth/schemas/user.schema';
import { Did, DidSchema } from '../dids/schemas/did.schema';
import { ProcessedPayment, ProcessedPaymentSchema } from './schemas/processed-payment.schema';

import { AdminModule } from '../admin/admin.module';
import { EnfonicaModule } from '../enfonica/enfonica.module';
import { Tradie, TradieSchema } from '../tradies/schemas/tradie.schema';
import { MailModule } from '../common/mail/mail.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Did.name, schema: DidSchema },
      { name: ProcessedPayment.name, schema: ProcessedPaymentSchema },
      { name: Tradie.name, schema: TradieSchema }
    ]),
    AdminModule,
    EnfonicaModule,
    MailModule,
  ],
  controllers: [PaymentsController, PaymentPagesController],
  providers: [PaymentsService]
})
export class PaymentsModule { }
