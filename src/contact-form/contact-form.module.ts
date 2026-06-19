import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ContactFormController } from './contact-form.controller';
import { ContactFormService } from './contact-form.service';
import { ContactForm, ContactFormSchema } from './schemas/contact-form.schema';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: ContactForm.name, schema: ContactFormSchema }]),
  ],
  controllers: [ContactFormController],
  providers: [ContactFormService],
})
export class ContactFormModule {}
