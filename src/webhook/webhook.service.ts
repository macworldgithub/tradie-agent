import { Injectable, Logger } from '@nestjs/common';
import { CallsService } from '../calls/calls.service';
import { DidsService } from '../dids/dids.service';
import { TradiesService } from '../tradies/tradies.service';
import { AriService } from '../ari/ari.service';

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    private readonly didsService: DidsService,
    private readonly tradiesService: TradiesService,
    private readonly callsService: CallsService,
    private readonly ariService: AriService,
  ) {}

  async handleIncoming(payload: {
    from: string;
    to: string;
    callStatus?: string;
  }) {
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
          callerNumber,
          didNumber,
          tradieNumber: undefined,
          callStatus: 'NO_MAPPING',
          fallbackUsed: false,
        });
        return { type: 'no_mapping' };
      }

      const tradie = await this.tradiesService.findById(did.assignedTradieId);
      const tradieNumber = tradie?.phoneNumber;

      // Log initiated call
      await this.callsService.create({
        callerNumber,
        didNumber,
        tradieNumber,
        callStatus: 'INITIATED',
        fallbackUsed: false,
      });

      if (tradieNumber) {
        await this.ariService.originateTradieCall(
          tradieNumber,
          callerNumber,
          didNumber,
        );
      } else {
        this.logger.warn(`No tradie number found for DID ${didNumber}`);
      }

      return { type: 'ack' };
    }

    // If callStatus exists handle fallback conditions
    const status = callStatus;
    const fallbackStatuses = ['NOT_ANSWERED', 'BUSY', 'FAILED'];
    let fallbackUsed = false;

    if (fallbackStatuses.includes(status)) {
      this.logger.log(
        `Call to tradie failed with status=${status}. Triggering ARI fallback.`,
      );
      try {
        await this.ariService.handleFallbackCall(callerNumber, didNumber);
        fallbackUsed = true;
      } catch (err) {
        this.logger.error('ARI fallback failed', err?.message || err);
      }
    }

    // Persist call result
    await this.callsService.create({
      callerNumber,
      didNumber,
      tradieNumber: undefined,
      callStatus: status,
      fallbackUsed,
    });

    return { type: 'ack' };
  }
}
