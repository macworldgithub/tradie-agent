import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import { CallsService } from '../calls/calls.service';
import { DidsService } from '../dids/dids.service';
import { TradiesService } from '../tradies/tradies.service';

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly didsService: DidsService,
    private readonly tradiesService: TradiesService,
    private readonly callsService: CallsService,
  ) { }

  async handleIncoming(
    payload: any,
    enfonicaCallIdFromQuery?: string,
  ): Promise<{ type: string; body?: string }> {
    console.log('=== RAW PAYLOAD ===', JSON.stringify(payload));

    // Enfonica sends data nested inside a 'call' object
    const callData = payload.call || payload;

    const enfonicaCallId = callData.name;
    const callerNumber = callData.from;
    const didNumber = callData.to;
    const callState = callData.state;

    // --- IDEMPOTENCY GUARD ---
    const existingCall = enfonicaCallId
      ? await this.callsService.findByEnfonicaCallId(enfonicaCallId)
      : null;

    console.log('=== WEBHOOK HIT ===');
    console.log('enfonicaCallId:', enfonicaCallId);
    console.log('customerNumber:', callerNumber);
    console.log('didNumber:', didNumber);
    console.log('callState:', callState);
    console.log('existingCall found:', !!existingCall);

    // FIRST LEG — inbound call arriving
    const isCallback = payload.parameters?.action === 'CALL' || !!existingCall;
    if (!isCallback && (callState === 'STARTING' || !callState)) {
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

      if (did.assignedTradieIds && did.assignedTradieIds.length > 1) {
        const tradies = await this.tradiesService.findByIds(did.assignedTradieIds);
        const validTradieNumbers = tradies
          .map((t) => t.phoneNumber)
          .filter((num): num is string => !!num && num.startsWith('+'));

        if (validTradieNumbers.length === 0) {
          this.logger.error(`No valid tradie numbers in E164 format for multi-tradie DID: ${didNumber}`);
          return {
            type: 'voiceml',
            body: `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, this service is temporarily unavailable.</Say></Response>`,
          };
        }

        console.log('=== MULTI-TRADIE FETCHED ===');
        console.log('validTradieNumbers:', validTradieNumbers);
        console.log('tradieIds:', did.assignedTradieIds);

        if (callerNumber && didNumber) {
          await this.callsService.create({
            enfonicaCallId,
            callerNumber,
            didNumber,
            tradieIds: did.assignedTradieIds,
            tradieNumber: validTradieNumbers.join(','),
            status: 'initiated',
            callStatus: 'INITIATED',
            fallbackUsed: false,
          });
        }

        console.log('=== CALLLOG CREATED FOR MULTI-TRADIE ===');
        console.log('status: initiated');
        console.log('=== VOICEML CALLERID ===', didNumber);

        const endpointsXml = validTradieNumbers
          .map((num) => `<Endpoint>${num}</Endpoint>`)
          .join('');

        const voiceML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Call
    TimeoutSeconds="15"
    CallerId="${didNumber}"
    NextUri="/webhook/call"
    Strategy="simultaneous">${endpointsXml}</Call>
</Response>`;

        console.log('=== DIALLING MULTI-TRADIE ===');
        console.log('VoiceML sent to Enfonica, dialling:', validTradieNumbers);
        console.log('=== VOICEML BEING SENT ===\n', voiceML);
        return { type: 'voiceml', body: voiceML };
      }

      const tradie = await this.tradiesService.findById(did.assignedTradieId);
      const tradieNumber = tradie?.phoneNumber;

      if (!tradieNumber || !tradieNumber.startsWith('+')) {
        this.logger.error(`Tradie number is not E164 format: ${tradieNumber}`);
        return {
          type: 'voiceml',
          body: `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, this service is temporarily unavailable.</Say></Response>`,
        };
      }

      console.log('=== TRADIE FETCHED ===');
      console.log('tradieNumber:', tradieNumber);
      console.log('tradieId:', did.assignedTradieId);

      const tradieId = Types.ObjectId.isValid(did.assignedTradieId)
        ? new Types.ObjectId(did.assignedTradieId)
        : undefined;

      if (callerNumber && didNumber) {
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
      }

      console.log('=== CALLLOG CREATED ===');
      console.log('status: initiated');

      // If tradie is configured for USSD, skip dialing and go straight to SIP fallback
      if (tradie?.callMode === 'ussd') {
        // mark call as in_progress
        if (enfonicaCallId) {
          await this.callsService.updateCallStatus(enfonicaCallId, 'initiated');
        }

        const asteriskHost =
          this.configService.get<string>('ASTERISK_SIP_HOST') || '127.0.0.1';
        const resolvedCallId2 = enfonicaCallId;
        const encodedCallId = encodeURIComponent(resolvedCallId2);
        const safeCallerId =
          callerNumber && callerNumber.startsWith('+')
            ? callerNumber
            : didNumber;

        const voiceML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Please hold, connecting you to our assistant.</Say>
  <Call CallerId="${safeCallerId}">
    <Endpoint>sip:ai-bridge@${asteriskHost}:5060?X-Call-Id=${encodedCallId}</Endpoint>
  </Call>
</Response>`;
        return { type: 'voiceml', body: voiceML };
      }

      if (!tradieNumber) {
        this.logger.warn(`No tradie number found for DID ${didNumber}`);
        return { type: 'ack' };
      }

      console.log('=== VOICEML CALLERID ===', didNumber);

      const voiceML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Call
    TimeoutSeconds="15"
    CallerId="${didNumber}"
    NextUri="/webhook/call"
    Strategy="simultaneous"><Endpoint>${tradieNumber}</Endpoint></Call>
</Response>`;

      console.log('=== DIALLING TRADIE ===');
      console.log('VoiceML sent to Enfonica, dialling:', tradieNumber);
      console.log('=== VOICEML BEING SENT ===\n', voiceML);
      return { type: 'voiceml', body: voiceML };
    }

    // CALLBACK LEG — callStatus from query param/body
    const callStatus = payload.parameters?.callStatus;
    const queryEnfonicaCallId = enfonicaCallIdFromQuery;
    const resolvedCallId = callData.name || queryEnfonicaCallId;

    console.log('=== CALLBACK LEG HIT ===');
    console.log('callState:', callState);
    console.log('callStatus:', callStatus);
    console.log('enfonicaCallId from query:', queryEnfonicaCallId);

    if (callState === 'COMPLETED' || callStatus === 'COMPLETED') {
      console.log('=== CALL COMPLETED ===');
      if (resolvedCallId) {
        await this.callsService.updateCallStatus(resolvedCallId, 'completed');
      }
      return { type: 'voiceml', body: '<Response/>' };
    }

    const fallbackStatuses = ['NOT_ANSWERED', 'BUSY', 'FAILED'];
    if (
      fallbackStatuses.includes(callState) ||
      fallbackStatuses.includes(callStatus)
    ) {
      console.log('=== TRADIE DID NOT ANSWER ===');
      console.log('Triggering SIP fallback to Asterisk');
      if (resolvedCallId) {
        await this.callsService.updateCallStatus(resolvedCallId, 'no_answer');
      }

      const asteriskHost =
        this.configService.get<string>('ASTERISK_SIP_HOST') || '127.0.0.1';
      const resolvedCallId2 = resolvedCallId || enfonicaCallId;
      const encodedCallId = encodeURIComponent(resolvedCallId2);
      const safeCallerId =
        callerNumber && callerNumber.startsWith('+') ? callerNumber : didNumber;

      const voiceML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Please hold, connecting you to our assistant.</Say>
  <Call CallerId="${safeCallerId}">
    <Endpoint>sip:ai-bridge@${asteriskHost}:5060?X-Call-Id=${encodedCallId}</Endpoint>
  </Call>
</Response>`;
      return { type: 'voiceml', body: voiceML };
    }

    return { type: 'ack' };
  }
}
