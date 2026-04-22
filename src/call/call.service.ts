import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { Call, CallDocument, CallStatus } from './schemas/call.schema';
import { TradieService } from '../tradie/tradie.service';
import { PbxService } from '../pbx/pbx.service';
import { LeadService } from '../lead/lead.service';
import { NotificationService } from '../notification/notification.service';

@Injectable()
export class CallService {
  private readonly logger = new Logger(CallService.name);

  constructor(
    @InjectModel(Call.name) private callModel: Model<CallDocument>,
    private readonly tradieService: TradieService,
    @Inject(forwardRef(() => PbxService))
    private readonly pbxService: PbxService,
    private readonly leadService: LeadService,
    private readonly notificationService: NotificationService,
    private readonly configService: ConfigService,
  ) {}

  async handleIncomingCall(callData: {
    caller_number: string;
    called_number: string;
    call_id: string;
  }) {
    this.logger.log(`Handling incoming call: ${callData.call_id} from ${callData.caller_number} to ${callData.called_number}`);

    try {
      // Identify tradie by geo number
      const tradie = await this.tradieService.findByGeoNumber(callData.called_number);
      if (!tradie) {
        this.logger.error(`No tradie found for geo number: ${callData.called_number}`);
        return { success: false, error: 'No tradie found' };
      }

      // Create call record only after tradie is known (tradie_id is required in schema)
      const call = await this.createCallRecord({
        ...callData,
        tradie_id: (tradie as any)._id,
        status: CallStatus.INCOMING,
        start_time: new Date(),
      });

      // Check if tradie is available
      const isAvailable = await this.tradieService.isAvailable((tradie as any)._id.toString());
      if (!isAvailable) {
        this.logger.log(`Tradie ${(tradie as any)._id} is not available, redirecting to AI`);
        return this.redirectToAI(callData.call_id, (tradie as any)._id.toString());
      }

      // Attempt to call tradie
      const dialResult = await this.pbxService.dialTradie(
        tradie.mobile_number,
        callData.call_id,
      );

      if (!dialResult.success) {
        this.logger.error(`Failed to dial tradie: ${dialResult.error}`);
        return this.redirectToAI(callData.call_id, (tradie as any)._id.toString());
      }

      // Update call status
      await this.updateCallStatus(callData.call_id, CallStatus.DIALING_TRADE);

      // Wait for tradie to answer (4-6 seconds)
      const answerResult = await this.waitForTradieAnswer(callData.call_id, 6000);

      if (answerResult.answered) {
        this.logger.log(`Tradie answered call ${callData.call_id}`);
        await this.updateCallStatus(callData.call_id, CallStatus.CONNECTED_TO_TRADE);
        await this.callModel.findByIdAndUpdate((call as any)._id, { tradie_answered: true });
        return { success: true, action: 'connected_to_tradie' };
      } else {
        this.logger.log(`Tradie did not answer within timeout, redirecting to AI`);
        return this.redirectToAI(callData.call_id, (tradie as any)._id.toString());
      }

    } catch (error) {
      this.logger.error(`Error handling incoming call: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  private async waitForTradieAnswer(callId: string, timeoutMs: number): Promise<{ answered: boolean }> {
    return new Promise((resolve) => {
      let checkCount = 0;
      const maxChecks = Math.floor(timeoutMs / 1000); // Check every second

      const checkInterval = setInterval(async () => {
        checkCount++;

        try {
          const status = await this.pbxService.getCallStatus(callId);
          
          if (status.answered) {
            clearInterval(checkInterval);
            resolve({ answered: true });
            return;
          }

          if (checkCount >= maxChecks) {
            clearInterval(checkInterval);
            resolve({ answered: false });
            return;
          }
        } catch (error) {
          this.logger.error(`Error checking call status: ${error.message}`);
          clearInterval(checkInterval);
          resolve({ answered: false });
        }
      }, 1000);
    });
  }

  private async redirectToAI(callId: string, tradieId: string) {
    try {
      const call = await this.findByCallId(callId);
      const tradie = await this.tradieService.findById(tradieId);

      if (!call || !tradie) {
        throw new Error('Call or tradie not found');
      }

      // Update call status
      await this.updateCallStatus(callId, CallStatus.REDIRECTING_TO_AI);

      // Use tradie's specific AI endpoint or fall back to global AI endpoint from environment
      const aiEndpoint = tradie.ai_endpoint || this.configService.get<string>('AI_ENDPOINT');
      
      if (!aiEndpoint) {
        throw new Error('No AI endpoint configured');
      }

      this.logger.log(`Redirecting call ${callId} to AI endpoint: ${aiEndpoint}`);

      // Redirect call to AI endpoint
      const redirectResult = await this.pbxService.redirectToAI(callId, aiEndpoint);

      if (redirectResult.success) {
        await this.updateCallStatus(callId, CallStatus.CONNECTED_TO_AI);
        await this.callModel.findByIdAndUpdate((call as any)._id, { ai_handled: true });
        return { success: true, action: 'redirected_to_ai', ai_endpoint: aiEndpoint };
      } else {
        throw new Error(redirectResult.error);
      }

    } catch (error) {
      this.logger.error(`Error redirecting to AI: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async createCallRecord(callData: any): Promise<Call> {
    const call = new this.callModel(callData);
    return call.save();
  }

  async findByCallId(callId: string): Promise<Call | null> {
    return this.callModel.findOne({ call_id: callId }).exec();
  }

  async updateCallStatus(callId: string, status: CallStatus): Promise<Call | null> {
    return this.callModel.findOneAndUpdate(
      { call_id: callId },
      { status },
      { new: true }
    ).exec();
  }

  async handleAIData(aiData: {
    call_id: string;
    tradie_id: string;
    caller_number: string;
    issue: string;
    address: string;
    additional_info?: string;
    ai_transcript?: string;
  }) {
    this.logger.log(`Processing AI data for call: ${aiData.call_id}`);

    try {
      // Create lead from AI data
      const lead = await this.leadService.createFromAIData(aiData);

      // Update call record
      const call = await this.findByCallId(aiData.call_id);
      if (call) {
        await this.callModel.findByIdAndUpdate((call as any)._id, {
          status: CallStatus.COMPLETED,
          end_time: new Date(),
          duration: call.start_time ? Math.floor((new Date().getTime() - call.start_time.getTime()) / 1000) : 0,
        });
      }

      // Notify tradie
      const tradie = await this.tradieService.findById(aiData.tradie_id);
      if (tradie) {
        await this.notificationService.notifyTradie(tradie, lead);
        await this.leadService.markAsNotified((lead as any)._id.toString());
      }

      return { success: true, lead_id: (lead as any)._id };

    } catch (error) {
      this.logger.error(`Error processing AI data: ${error.message}`);
      return { success: false, error: error.message };
    }
  }
}
