import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ContactFormController } from './contact-form.controller';
import { ContactFormService } from './contact-form.service';
import { ContactForm, ContactFormSchema } from './schemas/contact-form.schema';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ContactForm.name, schema: ContactFormSchema },
    ]),
    CommonModule,
  ],
  controllers: [ContactFormController],
  providers: [ContactFormService],
})
export class ContactFormModule {}
