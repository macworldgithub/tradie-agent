import { Injectable, Logger } from '@nestjs/common';

export type CallSession = {
  callSid: string;
  callerID: string;
  did: string;
  tradieNumber?: string;
  companyId?: string;
  timestamp: string;
  callStatus?: string;
};

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);
  private readonly sessions = new Map<string, CallSession>();

  createSession(session: CallSession): void {
    this.sessions.set(session.callSid, session);
  }

  getSession(callSid: string): CallSession | undefined {
    return this.sessions.get(callSid);
  }

  updateSession(callSid: string, update: Partial<CallSession>): void {
    const current = this.sessions.get(callSid);
    if (!current) {
      this.logger.warn(`Session not found for callSid=${callSid}`);
      return;
    }
    this.sessions.set(callSid, { ...current, ...update });
  }

  updateCallStatus(callSid: string, callStatus: string): void {
    this.updateSession(callSid, { callStatus });
  }
}
