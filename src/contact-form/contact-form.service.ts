import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ContactForm, ContactFormDocument } from './schemas/contact-form.schema';
import { CreateContactFormDto } from './dtos/create-contact-form.dto';
import { NotificationService } from '../common/notification.service';

@Injectable()
export class ContactFormService {
  private readonly logger = new Logger(ContactFormService.name);

  constructor(
    @InjectModel(ContactForm.name) private contactFormModel: Model<ContactFormDocument>,
    private notificationService: NotificationService,
  ) { }

  async create(dto: CreateContactFormDto): Promise<ContactForm> {
    const createdForm = new this.contactFormModel(dto);
    const savedForm = await createdForm.save();

    try {
      const emailBody = `
New Contact Us Form Submission:

First Name: ${dto.firstName}
Last Name: ${dto.lastName}
Email: ${dto.email}
Message:
${dto.message}
      `.trim();

      await this.notificationService.sendEmail(
        'Info@miaai.com.au, syeddyaseenn@gmail.com',
        'New Contact Us Form Submission',
        emailBody
      );
      this.logger.log(`Contact form email sent for submission from ${dto.email}`);
    } catch (error) {
      this.logger.error(`Failed to send contact form email for ${dto.email}`, error);
    }

    return savedForm;
  }
}
