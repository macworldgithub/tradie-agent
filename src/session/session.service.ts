import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

export type CallSession = {
  callSid: string;
  callerID: string;
  did: string;
  tradieNumber?: string;
  companyId?: string;
  timestamp: string;
  callStatus?: string;
  createdAt?: number;
};

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);
  private readonly sessions = new Map<string, CallSession>();

  createSession(session: CallSession): void {
    this.sessions.set(session.callSid, { ...session, createdAt: Date.now() });
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

  deleteSession(callSid: string): void {
    this.sessions.delete(callSid);
    this.logger.log(`Session deleted for callSid: ${callSid}. Active sessions: ${this.sessions.size}`);
  }

  @Cron('0 */10 * * * *')
  cleanupStaleSessions(): void {
    const now = Date.now();
    const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
    for (const [callSid, session] of this.sessions.entries()) {
      if (session.createdAt && now - session.createdAt > TWO_HOURS_MS) {
        this.logger.warn(`[Cron] Cleaning stale session: ${callSid}`);
        this.sessions.delete(callSid);
      }
    }
  }
}
