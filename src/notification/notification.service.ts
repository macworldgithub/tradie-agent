import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import axios from 'axios';

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);
  private emailTransporter: nodemailer.Transporter;

  constructor(private readonly configService: ConfigService) {
    // Initialize email transporter
    this.emailTransporter = nodemailer.createTransport({
      host: this.configService.get<string>('SMTP_HOST'),
      port: this.configService.get<number>('SMTP_PORT'),
      secure: this.configService.get<string>('SMTP_SECURE') === 'true',
      auth: {
        user: this.configService.get<string>('SMTP_USER'),
        pass: this.configService.get<string>('SMTP_PASS'),
      },
    });
  }

  async notifyTradie(tradie: any, lead: any): Promise<{ success: boolean; error?: string }> {
    try {
      // Send SMS notification
      const smsResult = await this.sendSMS(tradie.mobile_number, this.buildSMSMessage(tradie, lead));
      
      // Send email notification
      const emailResult = await this.sendEmail(tradie, lead);

      this.logger.log(`Notifications sent to tradie ${tradie._id}: SMS=${smsResult.success}, Email=${emailResult.success}`);
      
      return { success: smsResult.success || emailResult.success };

    } catch (error) {
      this.logger.error(`Failed to notify tradie: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  private async sendSMS(to: string, message: string): Promise<{ success: boolean; error?: string }> {
    try {
      const smsProvider = this.configService.get<string>('SMS_PROVIDER');
      
      switch (smsProvider) {
        case 'twilio':
          return this.sendTwilioSMS(to, message);
        case 'messagebird':
          return this.sendMessagebirdSMS(to, message);
        default:
          // Mock SMS for development
          this.logger.log(`MOCK SMS to ${to}: ${message}`);
          return { success: true };
      }

    } catch (error) {
      this.logger.error(`SMS sending failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  private async sendTwilioSMS(to: string, message: string): Promise<{ success: boolean; error?: string }> {
    try {
      const accountSid = this.configService.get<string>('TWILIO_ACCOUNT_SID');
      const authToken = this.configService.get<string>('TWILIO_AUTH_TOKEN');
      const fromNumber = this.configService.get<string>('TWILIO_FROM_NUMBER');

      if (!accountSid || !authToken || !fromNumber) {
        throw new Error('Twilio configuration missing');
      }

      const response = await axios.post(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
        new URLSearchParams({
          From: fromNumber,
          To: to,
          Body: message,
        }).toString(),
        {
          auth: {
            username: accountSid,
            password: authToken,
          },
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      return { success: response.status === 201 };

    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  private async sendMessagebirdSMS(to: string, message: string): Promise<{ success: boolean; error?: string }> {
    try {
      const apiKey = this.configService.get<string>('MESSAGEBIRD_API_KEY');
      
      const response = await axios.post(
        'https://rest.messagebird.com/messages',
        {
          originator: 'TradieAgent',
          recipients: [to],
          body: message,
        },
        {
          headers: {
            'Authorization': `AccessKey ${apiKey}`,
            'Content-Type': 'application/json',
          },
        }
      );

      return { success: response.status === 201 };

    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  private async sendEmail(tradie: any, lead: any): Promise<{ success: boolean; error?: string }> {
    try {
      const mailOptions = {
        from: this.configService.get<string>('SMTP_FROM_EMAIL'),
        to: tradie.email || 'noreply@tradieagent.com',
        subject: `New Job Request: ${lead.issue}`,
        html: this.buildEmailTemplate(tradie, lead),
      };

      await this.emailTransporter.sendMail(mailOptions);
      return { success: true };

    } catch (error) {
      this.logger.error(`Email sending failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  private buildSMSMessage(tradie: any, lead: any): string {
    return `New job request: ${lead.issue} at ${lead.address} from ${lead.caller_number}. Please contact customer ASAP.`;
  }

  private buildEmailTemplate(tradie: any, lead: any): string {
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #333;">New Job Request</h2>
        <p>Hi ${tradie.name},</p>
        <p>You have received a new job request from a customer:</p>
        
        <div style="background-color: #f5f5f5; padding: 20px; border-radius: 5px; margin: 20px 0;">
          <h3 style="margin-top: 0;">Job Details:</h3>
          <p><strong>Issue:</strong> ${lead.issue}</p>
          <p><strong>Address:</strong> ${lead.address}</p>
          <p><strong>Customer Phone:</strong> ${lead.caller_number}</p>
          ${lead.additional_info ? `<p><strong>Additional Info:</strong> ${lead.additional_info}</p>` : ''}
        </div>
        
        <p>Please contact the customer as soon as possible to discuss their requirements.</p>
        
        <p>Best regards,<br>Tradie Agent System</p>
      </div>
    `;
  }

  async sendTestNotification(): Promise<{ success: boolean; error?: string }> {
    try {
      const testTradie = {
        _id: 'test-id',
        name: 'Test Tradie',
        mobile_number: '+61400000000',
        email: 'test@example.com',
      };

      const testLead = {
        issue: 'Test leaky tap',
        address: '123 Test Street, Testville',
        caller_number: '+61400000001',
        additional_info: 'Customer mentioned urgent issue',
      };

      return await this.notifyTradie(testTradie, testLead);

    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}
