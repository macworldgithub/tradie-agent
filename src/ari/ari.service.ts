import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import WebSocket from 'ws';
import { VoiceAgentService } from '../voice-agent/voice-agent.service';

type AriEvent = {
  type?: string;
  timestamp?: string;
  channel?: {
    id?: string;
    caller?: {
      number?: string;
      name?: string;
    };
    dialplan?: {
      exten?: string;
      context?: string;
    };
  };
};

@Injectable()
export class AriService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AriService.name);
  private eventSocket: WebSocket | null = null;
  private lastEventAt: string | null = null;
  private connected = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly voiceAgentService: VoiceAgentService,
  ) {}

  onModuleInit() {
    const autoConnect = this.configService.get<string>(
      'ASTERISK_ARI_AUTO_CONNECT',
    );
    if (autoConnect === 'true') {
      this.connectEventSocket();
    }
  }

  onModuleDestroy() {
    if (this.eventSocket) {
      this.eventSocket.close();
      this.eventSocket = null;
    }
  }

  getHealth() {
    return {
      status: this.connected ? 'connected' : 'disconnected',
      app: this.getAriApp(),
      ariUrl: this.getAriBaseUrl(),
      lastEventAt: this.lastEventAt,
      timestamp: new Date().toISOString(),
    };
  }

  private connectEventSocket() {
    const wsUrl = this.getEventSocketUrl();

    this.logger.log(
      `Connecting ARI event socket: ${wsUrl.replace(/api_key=[^&]+/, 'api_key=***')}`,
    );
    this.eventSocket = new WebSocket(wsUrl);

    this.eventSocket.on('open', () => {
      this.connected = true;
      this.logger.log('ARI event socket connected');
    });

    this.eventSocket.on('message', async (rawData: WebSocket.RawData) => {
      this.lastEventAt = new Date().toISOString();

      try {
        const payload = JSON.parse(rawData.toString()) as AriEvent;
        if (payload.type === 'StasisStart') {
          await this.handleStasisStart(payload);
        }
      } catch (error) {
        this.logger.error(
          `Failed to parse ARI event: ${(error as Error).message}`,
        );
      }
    });

    this.eventSocket.on('close', () => {
      this.connected = false;
      this.logger.warn('ARI event socket disconnected');
    });

    this.eventSocket.on('error', (error) => {
      this.connected = false;
      this.logger.error(`ARI event socket error: ${error.message}`);
    });
  }

  private async handleStasisStart(event: AriEvent) {
    const channelId = event.channel?.id;
    const callerNumber = event.channel?.caller?.number || 'unknown';
    const calledNumber = event.channel?.dialplan?.exten || 'unknown';

    this.logger.log(
      `StasisStart received. channel=${channelId || 'unknown'} caller=${callerNumber} called=${calledNumber}`,
    );

    await this.voiceAgentService.handleIncomingCall({
      call_id: channelId || `ari-${Date.now()}`,
      caller_number: callerNumber,
      called_number: calledNumber,
    });
  }

  private getAriBaseUrl(): string {
    return (
      this.configService.get<string>('ASTERISK_ARI_URL') ||
      'http://127.0.0.1:8088'
    );
  }

  private getAriApp(): string {
    return this.configService.get<string>('ASTERISK_ARI_APP') || 'ai-bridge';
  }

  private getAriUsername(): string {
    return this.configService.get<string>('ASTERISK_ARI_USERNAME') || 'tradie';
  }

  private getAriPassword(): string {
    return this.configService.get<string>('ASTERISK_ARI_PASSWORD') || 'tradie';
  }

  private getEventSocketUrl(): string {
    const httpUrl = this.getAriBaseUrl();
    const wsBaseUrl = httpUrl
      .replace(/^http:/i, 'ws:')
      .replace(/^https:/i, 'wss:');
    const query = new URLSearchParams({
      app: this.getAriApp(),
      api_key: `${this.getAriUsername()}:${this.getAriPassword()}`,
    });
    return `${wsBaseUrl}/ari/events?${query.toString()}`;
  }
}
