import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CallsService } from '../calls/calls.service';
import { TradiesService } from '../tradies/tradies.service';
import { MailService } from '../common/mail/mail.service';
import { Customer, CustomerDocument } from './Schema/customer.schema';

interface CallEndedEvent {
  enfonicaCallId: string;
  customerNumber: string;
  didNumber: string;
  startTime: Date;
  endTime: Date;
}

@Injectable()
export class EmailWorkerService {
  private readonly logger = new Logger(EmailWorkerService.name);

  constructor(
    private readonly callsService: CallsService,
    private readonly tradiesService: TradiesService,
    private readonly mailService: MailService,
    @InjectModel(Customer.name)
    private readonly customerModel: Model<CustomerDocument>,
  ) { }

  async processPostCallEmail(event: CallEndedEvent): Promise<void> {
    const { enfonicaCallId, customerNumber, didNumber, startTime, endTime } = event;
    this.logger.log(`Starting post-call email processing for call ${enfonicaCallId}`);

    try {
      // 1. Fetch CallLog from DB
      const callRecord = await this.callsService.findByEnfonicaCallId(enfonicaCallId);
      if (!callRecord) {
        this.logger.warn(`No CallLog found in DB for enfonicaCallId: ${enfonicaCallId}`);
        return;
      }

      // Safeguard: Only send emails for calls where a booking was successfully completed (saved to DB)
      if (callRecord.status !== 'completed' || !callRecord.summary) {
        this.logger.log(
          `Skipping post-call email for ${enfonicaCallId}: call status is '${callRecord.status}' (not completed)`,
        );
        return;
      }

      let tradieInfoSection = '';
      let recipientEmail = '';
      let ccEmails: string[] = [];

      const idsToUse = callRecord.tradieIds?.length 
        ? callRecord.tradieIds 
        : (callRecord.tradieId ? [String(callRecord.tradieId)] : []);

      if (idsToUse.length === 0) {
        this.logger.warn(`CallLog ${enfonicaCallId} does not have any tradieIds or tradieId`);
        return;
      }

      const tradies = await this.tradiesService.findByIds(idsToUse);
      if (tradies.length === 0) {
        this.logger.warn(`No Tradies found in DB for IDs: ${idsToUse.join(',')}`);
        return;
      }

      const activeEmailTradies = tradies.filter(
        (t) => t.email && (t.notificationPreference === 'email' || t.notificationPreference === 'both')
      );

      if (activeEmailTradies.length === 0) {
        this.logger.log('Skipping email notification: no active tradies with email notification preference');
        return;
      }

      recipientEmail = activeEmailTradies[0].email!;
      ccEmails = activeEmailTradies.slice(1).map((t) => t.email!);

      tradieInfoSection = tradies
        .map((t) => `* name: ${t.name}\n* email: ${t.email || 'N/A'}`)
        .join('\n\n');

      // 3. Fetch Customer/Lead document from DB
      let phoneToQuery = customerNumber;
      if (callRecord.summary && typeof callRecord.summary === 'object') {
        const summaryPhone = (callRecord.summary as any).phone;
        if (summaryPhone) {
          phoneToQuery = summaryPhone;
        }
      }

      let customer = await this.customerModel
        .findOne({ phone: phoneToQuery })
        .sort({ createdAt: -1 })
        .exec();

      // Fallback 1: Try with customerNumber from session if different
      if (!customer && phoneToQuery !== customerNumber) {
        customer = await this.customerModel
          .findOne({ phone: customerNumber })
          .sort({ createdAt: -1 })
          .exec();
      }

      // Fallback 2: Clean and match suffix
      if (!customer) {
        const cleanNumber = (num: string) => num.replace(/\D/g, '').replace(/^(61|0)/, '');
        const targetClean = cleanNumber(phoneToQuery || customerNumber || '');
        if (targetClean) {
          const customers = await this.customerModel.find().sort({ createdAt: -1 }).limit(100).exec();
          customer = customers.find((c) => cleanNumber(c.phone) === targetClean) || null;
        }
      }

      if (!customer) {
        this.logger.warn(
          `No Customer/Lead document found for phone number: ${phoneToQuery || customerNumber}`,
        );
        return;
      }

      // 4. Calculate duration
      const durationMs = endTime.getTime() - startTime.getTime();
      const durationSeconds = Math.round(durationMs / 1000);

      const dateFormatOptions: Intl.DateTimeFormatOptions = {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZoneName: 'short',
      };
      const formattedStartTime = startTime.toLocaleString('en-AU', dateFormatOptions);
      const formattedEndTime = endTime.toLocaleString('en-AU', dateFormatOptions);

      // 5. Construct email details
      const subject = `Post-Call Summary: ${customer.name || 'New Lead'}`;
      const body = `Post-Call Email Notification

=== Customer Booking ===
* name: ${customer.name}
* phone : ${customerNumber}
* address: ${customer.address}
* urgency: ${customer.urgency}
* Service Type: ${customer.serviceType}
* Problem Description: ${customer.problemDescription}
* preferred Time: ${customer.preferredTime}
* summary: ${customer.summary || 'N/A'}

=== Call Metadata ===
* didNumber: ${callRecord.didNumber || didNumber}
* startTime: ${formattedStartTime}
* endTime: ${formattedEndTime}
* duration: ${durationSeconds} seconds

=== Tradie Info ===
${tradieInfoSection}
`;

      // 6. Send the email via NotificationService
      this.logger.log(`Sending post-call summary email to: ${recipientEmail}${ccEmails.length > 0 ? ` (CC: ${ccEmails.join(',')})` : ''}`);
      await this.mailService.sendPostCallSummaryEmail(
        recipientEmail,
        ccEmails.length > 0 ? ccEmails : undefined,
        subject,
        {
          customerName: customer.name || 'N/A',
          customerPhone: customerNumber,
          address: customer.address || 'N/A',
          urgency: customer.urgency || 'N/A',
          serviceType: customer.serviceType || 'N/A',
          problemDescription: customer.problemDescription || 'N/A',
          preferredTime: customer.preferredTime || 'N/A',
          summary: customer.summary || 'N/A',
          didNumber: callRecord.didNumber || didNumber,
          startTime: formattedStartTime,
          endTime: formattedEndTime,
          duration: durationSeconds,
          tradieInfo: tradieInfoSection,
        },
      );
      this.logger.log(`Successfully sent email to: ${recipientEmail}`);
    } catch (err) {
      this.logger.error(`Failed to process post-call email for ${enfonicaCallId}:`, err);
    }
  }
}
