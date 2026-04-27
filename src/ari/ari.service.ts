import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
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
  application?: string;
};

type AriCallSession = {
  callId: string;
  inboundChannelId: string;
  bridgeId: string;
  externalMediaChannelId?: string;
  createdAt: string;
};

@Injectable()
export class AriService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AriService.name);
  private eventSocket: WebSocket | null = null;
  private lastEventAt: string | null = null;
  private connected = false;
  private readonly ariHttpClient: AxiosInstance;
  private readonly sessions = new Map<string, AriCallSession>();

  constructor(
    private readonly configService: ConfigService,
    private readonly voiceAgentService: VoiceAgentService,
  ) {
    this.ariHttpClient = axios.create({
      timeout: 10000,
      auth: {
        username: this.getAriUsername(),
        password: this.getAriPassword(),
      },
    });
  }

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
      activeSessions: this.sessions.size,
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
        } else if (
          payload.type === 'StasisEnd' ||
          payload.type === 'ChannelDestroyed'
        ) {
          await this.handleChannelCleanup(payload);
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

    if (!channelId) {
      this.logger.warn('StasisStart received without channel ID');
      return;
    }

    this.logger.log(
      `StasisStart received. channel=${channelId || 'unknown'} caller=${callerNumber} called=${calledNumber}`,
    );

    const callId = channelId;
    const bridgeId = `bridge-${callId}`;

    try {
      await this.answerChannel(channelId);
      await this.createBridge(bridgeId);
      await this.addChannelToBridge(bridgeId, channelId);

      const externalMediaHost =
        this.configService.get<string>('ASTERISK_EXTERNAL_MEDIA_HOST') ||
        '127.0.0.1:6000';

      const externalMediaChannelId = await this.createExternalMediaChannel(
        callId,
        externalMediaHost,
      );

      if (externalMediaChannelId) {
        await this.addChannelToBridge(bridgeId, externalMediaChannelId);
      }

      this.sessions.set(callId, {
        callId,
        inboundChannelId: channelId,
        bridgeId,
        externalMediaChannelId,
        createdAt: new Date().toISOString(),
      });

      this.logger.log(
        `ARI bridge ready. call=${callId} bridge=${bridgeId} extMedia=${externalMediaChannelId || 'none'}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to initialize ARI call bridge for ${callId}: ${(error as Error).message}`,
      );
    }

    await this.voiceAgentService.handleIncomingCall({
      call_id: callId,
      caller_number: callerNumber,
      called_number: calledNumber,
    });
  }

  private async handleChannelCleanup(event: AriEvent) {
    const channelId = event.channel?.id;
    if (!channelId) {
      return;
    }

    const session = this.findSessionByChannel(channelId);
    if (!session) {
      return;
    }

    await this.cleanupSession(session.callId);
  }

  private findSessionByChannel(channelId: string): AriCallSession | undefined {
    for (const session of this.sessions.values()) {
      if (
        session.inboundChannelId === channelId ||
        session.externalMediaChannelId === channelId
      ) {
        return session;
      }
    }
    return undefined;
  }

  private async cleanupSession(callId: string) {
    const session = this.sessions.get(callId);
    if (!session) {
      return;
    }

    this.logger.log(`Cleaning up ARI session for call=${callId}`);

    if (session.externalMediaChannelId) {
      await this.safeHangupChannel(session.externalMediaChannelId);
    }
    await this.safeDestroyBridge(session.bridgeId);
    this.sessions.delete(callId);
  }

  private async answerChannel(channelId: string) {
    await this.ariRequest(
      'post',
      `/channels/${encodeURIComponent(channelId)}/answer`,
    );
  }

  private async createBridge(bridgeId: string) {
    await this.ariRequest('post', '/bridges', {
      type: 'mixing',
      bridgeId,
      name: bridgeId,
    });
  }

  private async addChannelToBridge(bridgeId: string, channelId: string) {
    await this.ariRequest(
      'post',
      `/bridges/${encodeURIComponent(bridgeId)}/addChannel`,
      {
        channel: channelId,
      },
    );
  }

  private async createExternalMediaChannel(
    callId: string,
    externalHost: string,
  ): Promise<string | undefined> {
    const response = await this.ariRequest<any>(
      'post',
      '/channels/externalMedia',
      {
        app: this.getAriApp(),
        channelId: `extmedia-${callId}`,
        external_host: externalHost,
        format: 'ulaw',
        direction: 'both',
      },
    );

    return response?.id;
  }

  private async safeHangupChannel(channelId: string) {
    try {
      await this.ariRequest(
        'delete',
        `/channels/${encodeURIComponent(channelId)}`,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to hangup channel ${channelId}: ${(error as Error).message}`,
      );
    }
  }

  private async safeDestroyBridge(bridgeId: string) {
    try {
      await this.ariRequest(
        'delete',
        `/bridges/${encodeURIComponent(bridgeId)}`,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to destroy bridge ${bridgeId}: ${(error as Error).message}`,
      );
    }
  }

  private async ariRequest<T = unknown>(
    method: 'get' | 'post' | 'delete',
    path: string,
    params?: Record<string, string>,
  ): Promise<T> {
    const url = `${this.getAriBaseUrl()}/ari${path}`;
    const response = await this.ariHttpClient.request<T>({
      method,
      url,
      params,
    });
    return response.data;
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
