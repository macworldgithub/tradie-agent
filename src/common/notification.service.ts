import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(private configService: ConfigService) {}
  private transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  async sendEmail(to: string, subject: string, body: string, cc?: string[]): Promise<void> {
    await this.transporter.sendMail({
      from: process.env.SMTP_USER,
      to,
      cc,
      subject,
      text: body,
    });
  }

  async sendSms(to: string, body: string): Promise<void> {
    const username = this.configService.get<string>('MOBILEMESSAGE_USERNAME');
    const password = this.configService.get<string>('MOBILEMESSAGE_PASSWORD');
    const from = this.configService.get<string>('MOBILEMESSAGE_FROM');

    const credentials = Buffer.from(`${username}:${password}`).toString('base64');

    try {
      const response = await fetch('https://api.mobilemessage.com.au/v1/messages', {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          enable_unicode: true,
          messages: [
            {
              to,
              message: body,
              sender: from,
            }
          ]
        })
      });

      const result = await response.json();
      if (result.results?.[0]?.status !== 'success') {
        this.logger.error(`MobileMessage SMS failed: ${JSON.stringify(result)}`);
      } else {
        this.logger.log(`SMS sent successfully to ${to}`);
      }
    } catch (err: any) {
      // Log but don't throw — SMS failure should not break the notification flow
      this.logger.error(`SMS send error to ${to}: ${err.message}`);
    }
  }
}
