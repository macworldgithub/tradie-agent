import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { CallEventEmitter } from './call-event-emitter';
import { EmailWorkerService } from './email-worker.service';
import { SmsWorkerService } from './sms-worker.service';

@Injectable()
export class CallEventsHandler implements OnModuleInit {
  private readonly logger = new Logger(CallEventsHandler.name);

  constructor(
    private readonly callEventEmitter: CallEventEmitter,
    private readonly emailWorkerService: EmailWorkerService,
    private readonly smsWorkerService: SmsWorkerService,
  ) {}

  onModuleInit() {
    this.callEventEmitter.on('call.ended', (event) => {
      this.logger.log(
        `Received call.ended event for enfonicaCallId: ${event.enfonicaCallId}`,
      );
      // Use setImmediate to execute fire-and-forget in the background
      setImmediate(() => {
        this.emailWorkerService.processPostCallEmail(event).catch((err) => {
          this.logger.error(
            `Error processing post-call email for ${event.enfonicaCallId}:`,
            err,
          );
        });
        this.smsWorkerService.processPostCallSms(event).catch((err) => {
          this.logger.error(
            `Error processing post-call SMS for ${event.enfonicaCallId}:`,
            err,
          );
        });
      });
    });
  }
}
