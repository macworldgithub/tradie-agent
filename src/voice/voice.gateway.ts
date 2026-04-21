import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { VoiceService } from './voice.service';

interface PrewarmState {
  promise: Promise<void>;
  ready: boolean;
  failed: boolean;
  ttlTimer: ReturnType<typeof setTimeout>;
}

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class VoiceGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer() server: Server;
  private logger: Logger = new Logger('VoiceGateway');
  private readonly prewarmTtlMs = 60_000;
  private readonly prewarmStates = new Map<string, PrewarmState>();

  constructor(private readonly voiceService: VoiceService) {}

  afterInit(server: Server) {
    this.logger.log('Voice Gateway Initialized');
  }

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
    // Pre-warm the realtime session in the background so start is faster.
    void this.startPrewarm(client);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
    this.clearPrewarmState(client.id);
    // Clean up the Realtime session when the browser disconnects
    this.voiceService.closeSession(client.id);
  }

  @SubscribeMessage('start-session')
  async handleStartSession(@ConnectedSocket() client: Socket) {
    const sessionId = client.id;
    this.logger.log(`[VoiceGateway] Starting realtime session: ${sessionId}`);

    try {
      let state = this.prewarmStates.get(sessionId);

      // If no prewarm exists (or previous one already cleared), start one now.
      if (!state) {
        await this.startPrewarm(client);
        state = this.prewarmStates.get(sessionId);
      }

      // Reuse prewarmed session when available.
      if (state) {
        try {
          await state.promise;
          if (state.ready) {
            this.clearPrewarmState(sessionId);
            client.emit('session-started', { sessionId });
            this.voiceService.triggerGreeting(sessionId);
            return;
          }
        } catch {
          // Fall back to direct creation below.
        }

        this.clearPrewarmState(sessionId);
      }

      // Fallback path: create realtime session directly.
      await this.voiceService.createRealtimeSession(
        sessionId,
        this.buildSessionEventForwarder(client),
      );

      // Tell the browser the session is ready
      client.emit('session-started', { sessionId });

      // Trigger the agent to greet the user
      this.voiceService.triggerGreeting(sessionId);
    } catch (err) {
      this.logger.error(
        `[VoiceGateway] Failed to start session: ${err.message}`,
      );
      client.emit('realtime-error', {
        error: { message: 'Failed to connect to AI service' },
      });
    }
  }

  @SubscribeMessage('audio-chunk')
  handleAudioChunk(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { audio: string },
  ) {
    this.voiceService.sendAudio(client.id, data.audio);
  }

  @SubscribeMessage('end-session')
  handleEndSession(@ConnectedSocket() client: Socket) {
    this.logger.log(`[VoiceGateway] Ending session: ${client.id}`);
    this.clearPrewarmState(client.id);
    this.voiceService.closeSession(client.id);
    client.emit('session-closed', {});
  }

  private async startPrewarm(client: Socket): Promise<void> {
    const sessionId = client.id;
    const existing = this.prewarmStates.get(sessionId);
    if (existing) {
      return existing.promise;
    }

    let state: PrewarmState;
    const promise = this.voiceService
      .createRealtimeSession(sessionId, this.buildSessionEventForwarder(client))
      .then(() => {
        state.ready = true;
        state.failed = false;
        this.logger.log(`[VoiceGateway] Prewarm ready: ${sessionId}`);
      })
      .catch((err: Error) => {
        state.ready = false;
        state.failed = true;
        this.logger.warn(
          `[VoiceGateway] Prewarm failed for ${sessionId}: ${err.message}`,
        );
        throw err;
      });

    const ttlTimer = setTimeout(() => {
      const current = this.prewarmStates.get(sessionId);
      if (!current) return;
      this.logger.log(
        `[VoiceGateway] Prewarm TTL expired for ${sessionId}; closing idle session`,
      );
      this.clearPrewarmState(sessionId);
      this.voiceService.closeSession(sessionId);
    }, this.prewarmTtlMs);

    state = {
      promise,
      ready: false,
      failed: false,
      ttlTimer,
    };

    this.prewarmStates.set(sessionId, state);
    return promise;
  }

  private clearPrewarmState(sessionId: string): void {
    const state = this.prewarmStates.get(sessionId);
    if (!state) return;
    clearTimeout(state.ttlTimer);
    this.prewarmStates.delete(sessionId);
  }

  private buildSessionEventForwarder(client: Socket): (event: any) => void {
    return (event: any) => {
      switch (event.type) {
        case 'audio-delta':
          client.emit('audio-delta', { delta: event.delta });
          break;

        case 'transcript-delta':
          client.emit('transcript-delta', { delta: event.delta });
          break;

        case 'transcript-done':
          client.emit('transcript-done', {
            transcript: event.transcript,
          });
          break;

        case 'user-transcript':
          client.emit('user-transcript', {
            transcript: event.transcript,
          });
          break;

        case 'speech-started':
          client.emit('speech-started', {});
          break;

        case 'booking-saved':
          client.emit('booking-saved', event.data);
          break;

        case 'error':
          client.emit('realtime-error', { error: event.error });
          break;

        case 'session-closed':
          client.emit('session-closed', {});
          break;
      }
    };
  }
}
