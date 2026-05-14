import { Injectable, Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import { CallsService } from '../calls/calls.service';
import { DidsService } from '../dids/dids.service';
import { TradiesService } from '../tradies/tradies.service';

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    private readonly didsService: DidsService,
    private readonly tradiesService: TradiesService,
    private readonly callsService: CallsService,
  ) {}

  async handleIncoming(
    payload: {
      name?: string;
      from?: string;
      to?: string;
      callStatus?: string;
    },
    enfonicaCallIdFromQuery?: string,
  ) {
    const enfonicaCallId = payload.name;
    const callerNumber = payload.from;
    const didNumber = payload.to;
    const callStatus = payload.callStatus;

    console.log('=== WEBHOOK HIT ===');
    console.log('enfonicaCallId:', enfonicaCallId);
    console.log('customerNumber:', callerNumber);
    console.log('didNumber:', didNumber);
    console.log('callStatus:', callStatus);
    console.log('RAW PAYLOAD:', JSON.stringify(payload));

    if (!callStatus) {
      if (!callerNumber || !didNumber) {
        this.logger.warn('Missing callerNumber or didNumber in payload');
        return { type: 'ack' };
      }

      const did = await this.didsService.findByDidNumber(didNumber);
      if (!did) {
        console.log('=== DID NOT FOUND for:', didNumber);
        this.logger.warn(`No DID mapping for ${didNumber}`);
        return { type: 'no_mapping' };
      }

      console.log('=== DID LOOKUP ===');
      console.log('DID found:', JSON.stringify(did));

      const tradie = await this.tradiesService.findById(did.assignedTradieId);
      const tradieNumber = did.tradieNumber || tradie?.phoneNumber;

      console.log('=== TRADIE FETCHED ===');
      console.log('tradieNumber:', tradieNumber);
      console.log('tradieId:', did.assignedTradieId);

      const tradieId = Types.ObjectId.isValid(did.assignedTradieId)
        ? new Types.ObjectId(did.assignedTradieId)
        : undefined;

      await this.callsService.create({
        enfonicaCallId,
        callerNumber,
        didNumber,
        tradieId,
        tradieNumber,
        status: 'initiated',
        callStatus: 'INITIATED',
        fallbackUsed: false,
      });

      console.log('=== CALLLOG CREATED ===');
      console.log('status: initiated');

      if (!tradieNumber) {
        this.logger.warn(`No tradie number found for DID ${didNumber}`);
        return { type: 'ack' };
      }

      const voiceML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Call
    TimeoutSeconds="25"
    NextUri="/webhook/call?enfonicaCallId=${enfonicaCallId}"
    Strategy="simultaneous">
    ${tradieNumber}
  </Call>
</Response>`;

      console.log('=== DIALLING TRADIE ===');
      console.log('VoiceML sent to Enfonica, dialling:', tradieNumber);
      return { type: 'voiceml', body: voiceML };
    }

    const status = callStatus;
    const queryEnfonicaCallId = enfonicaCallIdFromQuery;

    console.log('=== CALLBACK LEG HIT ===');
    console.log('callStatus:', callStatus);
    console.log('enfonicaCallId from query:', enfonicaCallIdFromQuery);

    if (status === 'COMPLETED') {
      console.log('=== CALL COMPLETED ===');
      console.log('Tradie answered, updating CallLog to completed');
      if (queryEnfonicaCallId) {
        await this.callsService.updateCallStatus(
          queryEnfonicaCallId,
          'completed',
        );
      }
      return { type: 'voiceml', body: '<Response/>' };
    }

    const fallbackStatuses = ['NOT_ANSWERED', 'BUSY', 'FAILED'];
    if (fallbackStatuses.includes(status)) {
      console.log('=== TRADIE DID NOT ANSWER ===');
      console.log('Triggering SIP fallback to Asterisk');
      console.log('SIP URI: sip:ai-bridge@127.0.0.1:5060');
      if (queryEnfonicaCallId) {
        await this.callsService.updateCallStatus(
          queryEnfonicaCallId,
          'no_answer',
        );
      }

      const voiceML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Please hold, connecting you to our assistant.</Say>
  <Call>
    <Endpoint>sip:ai-bridge@127.0.0.1:5060?X-Call-Id=${encodeURIComponent(
      queryEnfonicaCallId || '',
    )}</Endpoint>
  </Call>
</Response>`;
      return { type: 'voiceml', body: voiceML };
    }

    return { type: 'ack' };
  }
}
