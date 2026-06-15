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
export class SmsWorkerService {
  private readonly logger = new Logger(SmsWorkerService.name);

  constructor(
    private readonly callsService: CallsService,
    private readonly tradiesService: TradiesService,
    private readonly notificationService: NotificationService,
    @InjectModel(Customer.name)
    private readonly customerModel: Model<CustomerDocument>,
  ) { }

  async processPostCallSms(event: CallEndedEvent): Promise<void> {
    const { enfonicaCallId, customerNumber, didNumber, startTime, endTime } = event;
    this.logger.log(`Starting post-call SMS processing for call ${enfonicaCallId}`);

    try {
      // 1. Fetch CallLog from DB
      const callRecord = await this.callsService.findByEnfonicaCallId(enfonicaCallId);
      if (!callRecord) {
        this.logger.warn(`No CallLog found in DB for enfonicaCallId: ${enfonicaCallId}`);
        return;
      }

      // Safeguard: Only send SMS for calls where a booking was successfully completed
      if (callRecord.status !== 'completed' || !callRecord.summary) {
        this.logger.log(`Skipping post-call SMS for ${enfonicaCallId}: call status is '${callRecord.status}' (not completed)`);
        return;
      }

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

      const activeSmsTradies = tradies.filter(
        t => t.phoneNumber && 
        (t.notificationPreference === 'sms' || t.notificationPreference === 'both')
      );

      if (activeSmsTradies.length === 0) {
        this.logger.log('Skipping SMS notification: no active tradies with SMS notification preference');
        return;
      }

      let tradieInfoSection = tradies
        .map((t) => `* name: ${t.name}\n* phone: ${t.phoneNumber}`)
        .join('\n\n');

      // 3. Fetch Customer/Lead document from DB
      let phoneToQuery = customerNumber;
      if (callRecord.summary && typeof callRecord.summary === 'object') {
        const summaryPhone = (callRecord.summary as any).phone;
        if (summaryPhone) {
          phoneToQuery = summaryPhone;
        }
      }

      let customer = await this.customerModel.findOne({ phone: phoneToQuery }).sort({ createdAt: -1 }).exec();

      if (!customer && phoneToQuery !== customerNumber) {
        customer = await this.customerModel.findOne({ phone: customerNumber }).sort({ createdAt: -1 }).exec();
      }

      if (!customer) {
        const cleanNumber = (num: string) => num.replace(/\D/g, '').replace(/^(61|0)/, '');
        const targetClean = cleanNumber(phoneToQuery || customerNumber || '');
        if (targetClean) {
          const customers = await this.customerModel.find().sort({ createdAt: -1 }).limit(100).exec();
          customer = customers.find((c) => cleanNumber(c.phone) === targetClean) || null;
        }
      }

      if (!customer) {
        this.logger.warn(`No Customer/Lead document found for phone number: ${phoneToQuery || customerNumber}`);
        return;
      }

      // 4. Calculate duration
      const durationMs = endTime.getTime() - startTime.getTime();
      const durationSeconds = Math.round(durationMs / 1000);

      // 5. Construct SMS details
      const body = `Post-Call SMS Notification

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
* startTime: ${startTime.toISOString()}
* endTime: ${endTime.toISOString()}
* duration: ${durationSeconds} seconds

=== Tradie Info ===
${tradieInfoSection}
`;

      // 6. Send the SMS
      for (const tradie of activeSmsTradies) {
        this.logger.log(`Sending post-call summary SMS to: ${tradie.phoneNumber}`);
        await this.notificationService.sendSms(tradie.phoneNumber, body);
      }
    } catch (err) {
      this.logger.error(`Failed to process post-call SMS for ${enfonicaCallId}:`, err);
    }
  }
}
