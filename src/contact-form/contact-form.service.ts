import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  ContactForm,
  ContactFormDocument,
} from './schemas/contact-form.schema';
import { CreateContactFormDto } from './dtos/create-contact-form.dto';
import { NotificationService } from '../common/notification.service';

@Injectable()
export class ContactFormService {
  private readonly logger = new Logger(ContactFormService.name);

  constructor(
    @InjectModel(ContactForm.name)
    private contactFormModel: Model<ContactFormDocument>,
    private notificationService: NotificationService,
  ) { }

  async create(dto: CreateContactFormDto): Promise<ContactForm> {
    const createdForm = new this.contactFormModel(dto);
    const savedForm = await createdForm.save();

    try {
      const plainText = [
        'New Contact Us Form Submission',
        '',
        `First Name:   ${dto.firstName}`,
        `Last Name:    ${dto.lastName}`,
        `Email:        ${dto.email}`,
        `Phone Number: ${dto.phoneNumber}`,
        `Message:      ${dto.message ?? 'N/A'}`,
      ].join('\n');

      const htmlBody = `
<!DOCTYPE html>
<html>
<body style="font-family:Arial,sans-serif;background:#f4f4f4;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;padding:32px;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
    <h2 style="margin-top:0;color:#1a1a2e;">New Contact Us Form Submission</h2>
    <table style="width:100%;border-collapse:collapse;">
      <tr>
        <td style="padding:10px 12px;font-weight:600;color:#555;width:140px;border-bottom:1px solid #eee;">First Name</td>
        <td style="padding:10px 12px;color:#222;border-bottom:1px solid #eee;">${dto.firstName}</td>
      </tr>
      <tr>
        <td style="padding:10px 12px;font-weight:600;color:#555;border-bottom:1px solid #eee;">Last Name</td>
        <td style="padding:10px 12px;color:#222;border-bottom:1px solid #eee;">${dto.lastName}</td>
      </tr>
      <tr>
        <td style="padding:10px 12px;font-weight:600;color:#555;border-bottom:1px solid #eee;">Email</td>
        <td style="padding:10px 12px;border-bottom:1px solid #eee;"><a href="mailto:${dto.email}" style="color:#4f46e5;">${dto.email}</a></td>
      </tr>
      <tr>
        <td style="padding:10px 12px;font-weight:600;color:#555;border-bottom:1px solid #eee;">Phone Number</td>
        <td style="padding:10px 12px;border-bottom:1px solid #eee;"><a href="tel:${dto.phoneNumber}" style="color:#4f46e5;">${dto.phoneNumber}</a></td>
      </tr>
      <tr>
        <td style="padding:10px 12px;font-weight:600;color:#555;vertical-align:top;">Message</td>
        <td style="padding:10px 12px;color:#222;white-space:pre-wrap;">${dto.message ?? '<em style="color:#999;">No message provided</em>'}</td>
      </tr>
    </table>
  </div>
</body>
</html>`.trim();

      await this.notificationService.sendEmail(
        'Info@miaai.com.au, syeddyaseenn@gmail.com, jawadpasha256@gmail.com, bilalashrafali@gmail.com',
        'New Contact Us Form Submission',
        plainText,
        undefined,
        htmlBody,
      );
      this.logger.log(
        `Contact form email sent for submission from ${dto.email}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to send contact form email for ${dto.email}`,
        error,
      );
    }

    return savedForm;
  }
}
