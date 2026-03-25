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

  constructor(private readonly voiceService: VoiceService) {}

  afterInit(server: Server) {
    this.logger.log('Voice Gateway Initialized');
  }

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
    // Clean up the Realtime session when the browser disconnects
    this.voiceService.closeSession(client.id);
  }

  @SubscribeMessage('start-session')
  async handleStartSession(@ConnectedSocket() client: Socket) {
    const sessionId = client.id;
    this.logger.log(`[VoiceGateway] Starting realtime session: ${sessionId}`);

    try {
      // Create a Realtime API session, forwarding events to the browser
      await this.voiceService.createRealtimeSession(
        sessionId,
        (event: any) => {
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
        },
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
    this.voiceService.closeSession(client.id);
    client.emit('session-closed', {});
  }
}
