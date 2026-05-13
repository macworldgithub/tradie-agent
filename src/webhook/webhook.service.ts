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
      from: string;
      to: string;
      callStatus?: string;
    },
    enfonicaCallIdFromQuery?: string,
  ) {
    const enfonicaCallId = payload.name;
    const callerNumber = payload.from;
    const didNumber = payload.to;
    const callStatus = payload.callStatus;

    if (!callStatus) {
      // First call: lookup DID and return VoiceML to call tradie
      const did = await this.didsService.findByDidNumber(didNumber);
      if (!did) {
        this.logger.warn(`No DID mapping for ${didNumber}`);
        // Log and return empty response
        await this.callsService.create({
          enfonicaCallId,
          callerNumber,
          didNumber,
          tradieNumber: undefined,
          callStatus: 'NO_MAPPING',
          fallbackUsed: false,
        });
        return { type: 'no_mapping' };
      }

      const tradie = await this.tradiesService.findById(did.assignedTradieId);
      const tradieNumber = did.tradieNumber || tradie?.phoneNumber;
      const tradieId = Types.ObjectId.isValid(did.assignedTradieId)
        ? new Types.ObjectId(did.assignedTradieId)
        : undefined;

      // Log initiated call
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
      return { type: 'voiceml', body: voiceML };
    }

    // If callStatus exists handle fallback conditions
    const status = callStatus;
    const queryEnfonicaCallId = enfonicaCallIdFromQuery;

    if (status === 'COMPLETED') {
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
