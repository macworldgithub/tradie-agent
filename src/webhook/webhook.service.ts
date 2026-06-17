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

      const extractId = (val: any): string | undefined =>
        val ? (typeof val === 'object' && val._id ? String(val._id) : String(val)) : undefined;

      const rawIds = (did.assignedTradieIds || []).map(extractId).filter((id): id is string => !!id);

      if (rawIds.length === 0) {
        this.logger.error(`No tradie assigned to DID: ${didNumber}`);
        return {
          type: 'voiceml',
          body: `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, this service is temporarily unavailable.</Say></Response>`,
        };
      }

      const tradies = await this.tradiesService.findByIds(rawIds);
      const validTradies = tradies.filter((t) => t.phoneNumber && t.phoneNumber.startsWith('+'));
      const validTradieNumbers = validTradies.map((t) => t.phoneNumber as string);

      if (validTradieNumbers.length === 0) {
        this.logger.error(`No valid tradie numbers in E164 format for DID: ${didNumber}`);
        return {
          type: 'voiceml',
          body: `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, this service is temporarily unavailable.</Say></Response>`,
        };
      }

      if (rawIds.length === 1) {
        const tradie = tradies[0];
        const tradieNumber = validTradieNumbers[0];
        const tradieId = Types.ObjectId.isValid(rawIds[0]) ? new Types.ObjectId(rawIds[0]) : undefined;

        console.log('=== TRADIE FETCHED ===');
        console.log('tradieNumber:', tradieNumber);
        console.log('tradieId:', rawIds[0]);

        if (callerNumber && didNumber) {
          await this.callsService.create({
            enfonicaCallId,
            callerNumber,
            didNumber,
            tradieId,
            tradieIds: rawIds, // Ensures the array is ALWAYS populated
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

          const asteriskHost = this.configService.get<string>('ASTERISK_SIP_HOST') || '127.0.0.1';
          const encodedCallId = encodeURIComponent(enfonicaCallId || '');
          const safeCallerId = callerNumber && callerNumber.startsWith('+') ? callerNumber : didNumber;

          const voiceML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Please hold, connecting you to our assistant.</Say>
  <Call CallerId="${safeCallerId}">
    <Endpoint>sip:ai-bridge@${asteriskHost}:5060?X-Call-Id=${encodedCallId}</Endpoint>
  </Call>
</Response>`;
          return { type: 'voiceml', body: voiceML };
        }

        console.log('=== VOICEML CALLERID ===', didNumber);

        const voiceML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Call
    TimeoutSeconds="5"
    CallerId="${didNumber}"
    NextUri="/webhook/call"
    Strategy="simultaneous"><Endpoint>${tradieNumber}</Endpoint></Call>
</Response>`;

        console.log('=== DIALLING TRADIE ===');
        console.log('VoiceML sent to Enfonica, dialling:', tradieNumber);
        console.log('=== VOICEML BEING SENT ===\n', voiceML);
        return { type: 'voiceml', body: voiceML };
      }

      // Multi-dial logic for length > 1
      console.log('=== MULTI-TRADIE FETCHED ===');
      console.log('validTradieNumbers:', validTradieNumbers);
      console.log('tradieIds:', rawIds);

      if (callerNumber && didNumber) {
        await this.callsService.create({
          enfonicaCallId,
          callerNumber,
          didNumber,
          tradieIds: rawIds,
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
    TimeoutSeconds="5"
    CallerId="${didNumber}"
    NextUri="/webhook/call"
    Strategy="simultaneous">${endpointsXml}</Call>
</Response>`;

      console.log('=== DIALLING MULTI-TRADIE ===');
      console.log('VoiceML sent to Enfonica, dialling:', validTradieNumbers);
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
