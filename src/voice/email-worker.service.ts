import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CallsService } from '../calls/calls.service';
import { TradiesService } from '../tradies/tradies.service';
import { NotificationService } from '../common/notification.service';
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
    private readonly notificationService: NotificationService,
    @InjectModel(Customer.name)
    private readonly customerModel: Model<CustomerDocument>,
  ) {}

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

      if (!callRecord.tradieId) {
        this.logger.warn(`CallLog ${enfonicaCallId} does not have a tradieId`);
        return;
      }

      // 2. Fetch Tradie from DB
      const tradie = await this.tradiesService.findById(String(callRecord.tradieId));
      if (!tradie) {
        this.logger.warn(`No Tradie found in DB with ID: ${callRecord.tradieId}`);
        return;
      }

      const preference = tradie.notificationPreference;
      const hasEmailPref = preference === 'email' || preference === 'both';
      if (!tradie.email || !hasEmailPref) {
        this.logger.log(
          `Skipping email notification: email=${tradie.email}, preference=${preference}`,
        );
        return;
      }

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

      // 5. Construct email details
      const subject = `Post-Call Summary: ${customer.name || 'New Lead'}`;
      const body = `Post-Call Email Notification

=== Customer Booking ===
* name: ${customer.name}
* phone (session.customerNumber): ${customerNumber}
* address: ${customer.address}
* urgency: ${customer.urgency}
* service_type: ${customer.serviceType}
* problem_description: ${customer.problemDescription}
* preferred_time: ${customer.preferredTime}
* summary: ${customer.summary || 'N/A'}

=== Call Metadata ===
* didNumber: ${didNumber}
* enfonicaCallId: ${enfonicaCallId}
* tradieId: ${callRecord.tradieId}
* startTime: ${startTime.toISOString()}
* endTime: ${endTime.toISOString()}
* duration: ${durationSeconds} seconds

=== Tradie Info ===
* email: ${tradie.email}
`;

      // 6. Send the email via NotificationService
      this.logger.log(`Sending post-call summary email to: ${tradie.email}`);
      await this.notificationService.sendEmail(tradie.email, subject, body);
      this.logger.log(`Successfully sent email to: ${tradie.email}`);
    } catch (err) {
      this.logger.error(`Failed to process post-call email for ${enfonicaCallId}:`, err);
    }
  }
}
