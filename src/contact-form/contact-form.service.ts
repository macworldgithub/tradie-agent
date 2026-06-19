import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ContactForm, ContactFormDocument } from './schemas/contact-form.schema';
import { CreateContactFormDto } from './dtos/create-contact-form.dto';

@Injectable()
export class ContactFormService {
  constructor(
    @InjectModel(ContactForm.name) private contactFormModel: Model<ContactFormDocument>,
  ) {}

  async create(dto: CreateContactFormDto): Promise<ContactForm> {
    const createdForm = new this.contactFormModel(dto);
    // Future: add email logic here
    return createdForm.save();
  }
}
