import { Controller, Post, Body, Param, Get } from '@nestjs/common';
import { CallService } from './call.service';
import { Call } from './schemas/call.schema';

@Controller('call')
export class CallController {
  constructor(private readonly callService: CallService) {}

  @Post('incoming')
  async handleIncomingCall(@Body() callData: {
    caller_number: string;
    called_number: string;
    call_id: string;
  }) {
    return this.callService.handleIncomingCall(callData);
  }

  @Post('ai-data')
  async handleAIData(@Body() aiData: {
    call_id: string;
    tradie_id: string;
    caller_number: string;
    issue: string;
    address: string;
    additional_info?: string;
    ai_transcript?: string;
  }) {
    return this.callService.handleAIData(aiData);
  }

  @Get(':callId')
  findByCallId(@Param('callId') callId: string) {
    return this.callService.findByCallId(callId);
  }

  @Get('tradie/:tradieId')
  async findByTradieId(@Param('tradieId') tradieId: string) {
    // This would need to be implemented in the service
    return { message: 'Find by tradie ID not implemented yet' };
  }
}
