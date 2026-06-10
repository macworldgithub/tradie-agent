// import {
//   Injectable,
//   Logger,
//   OnModuleDestroy,
//   OnModuleInit,
// } from '@nestjs/common';
// import { ConfigService } from '@nestjs/config';
// import dgram, { RemoteInfo, Socket } from 'dgram';

// type RemoteEndpoint = {
//   address: string;
//   port: number;
// };

// type RtpSession = {
//   callId: string;
//   remote?: RemoteEndpoint;
//   packetsRx: number;
//   bytesRx: number;
//   lastPacketAt?: string;
//   txSequence: number;
//   txTimestamp: number;
//   ssrc: number;
// };

// type AudioFrameHandler = (frame: {
//   callId: string;
//   payload: Buffer;
//   sequenceNumber: number;
//   timestamp: number;
//   marker: boolean;
//   payloadType: number;
// }) => void;

// @Injectable()
// export class AriRtpMediaService implements OnModuleInit, OnModuleDestroy {
//   private readonly logger = new Logger(AriRtpMediaService.name);
//   private socket: Socket | null = null;
//   private readonly sessions = new Map<string, RtpSession>();
//   private readonly remoteKeyToCallId = new Map<string, string>();
//   private onAudioFrameHandler: AudioFrameHandler | null = null;

//   constructor(private readonly configService: ConfigService) {}

//   onModuleInit() {
//     this.startSocket();
//   }

//   onModuleDestroy() {
//     if (this.socket) {
//       this.socket.close();
//       this.socket = null;
//     }
//   }

//   getHealth() {
//     return {
//       listening: Boolean(this.socket),
//       bindHost: this.getBindHost(),
//       bindPort: this.getBindPort(),
//       activeRtpSessions: this.sessions.size,
//     };
//   }

//   setAudioFrameHandler(handler: AudioFrameHandler) {
//     this.onAudioFrameHandler = handler;
//   }

//   registerCallSession(callId: string) {
//     if (this.sessions.has(callId)) {
//       return;
//     }

//     this.sessions.set(callId, {
//       callId,
//       packetsRx: 0,
//       bytesRx: 0,
//       txSequence: Math.floor(Math.random() * 65535),
//       txTimestamp: Math.floor(Math.random() * 0xffffffff),
//       ssrc: Math.floor(Math.random() * 0xffffffff),
//     });

//     this.logger.log(`RTP session registered for call=${callId}`);
//   }

//   unregisterCallSession(callId: string) {
//     const session = this.sessions.get(callId);
//     if (!session) {
//       return;
//     }

//     if (session.remote) {
//       this.remoteKeyToCallId.delete(this.toRemoteKey(session.remote));
//     }

//     this.sessions.delete(callId);
//     this.logger.log(`RTP session unregistered for call=${callId}`);
//   }

//   sendUlawToCall(callId: string, ulawPayload: Buffer) {
//     const session = this.sessions.get(callId);
//     if (!session || !session.remote || !this.socket) {
//       return;
//     }

//     const rtpPacket = this.buildRtpPacket(session, ulawPayload);
//     this.socket.send(rtpPacket, session.remote.port, session.remote.address);
//   }

//   private startSocket() {
//     if (this.socket) {
//       return;
//     }

//     this.socket = dgram.createSocket('udp4');

//     this.socket.on('message', (message: Buffer, remote: RemoteInfo) => {
//       this.handleIncomingPacket(message, remote);
//     });

//     this.socket.on('error', (error) => {
//       this.logger.error(`RTP socket error: ${error.message}`);
//     });

//     const host = this.getBindHost();
//     const port = this.getBindPort();
//     this.socket.bind(port, host, () => {
//       this.logger.log(`RTP media socket listening on ${host}:${port}`);
//     });
//   }

//   private handleIncomingPacket(packet: Buffer, remote: RemoteInfo) {
//     if (packet.length < 12) {
//       return;
//     }

//     const remoteKey = this.toRemoteKey({
//       address: remote.address,
//       port: remote.port,
//     });
//     let callId = this.remoteKeyToCallId.get(remoteKey);

//     if (!callId) {
//       callId = this.bindRemoteToPendingSession(remote.address, remote.port);
//       if (!callId) {
//         return;
//       }
//     }

//     const session = this.sessions.get(callId);
//     if (!session) {
//       return;
//     }

//     const version = packet[0] >> 6;
//     if (version !== 2) {
//       return;
//     }

//     const marker = (packet[1] & 0x80) !== 0;
//     const payloadType = packet[1] & 0x7f;
//     if (payloadType !== 0) {
//       return;
//     }
//     const sequenceNumber = packet.readUInt16BE(2);
//     const timestamp = packet.readUInt32BE(4);

//     const csrcCount = packet[0] & 0x0f;
//     const headerLength = 12 + csrcCount * 4;
//     if (packet.length < headerLength) {
//       return;
//     }

//     const payload = packet.subarray(headerLength);
//     session.packetsRx += 1;
//     session.bytesRx += payload.length;
//     session.lastPacketAt = new Date().toISOString();

//     if (this.onAudioFrameHandler) {
//       this.onAudioFrameHandler({
//         callId,
//         payload,
//         sequenceNumber,
//         timestamp,
//         marker,
//         payloadType,
//       });
//     }
//   }

//   private bindRemoteToPendingSession(
//     address: string,
//     port: number,
//   ): string | undefined {
//     const unboundSession = [...this.sessions.values()].find(
//       (session) => !session.remote,
//     );
//     if (!unboundSession) {
//       return undefined;
//     }

//     unboundSession.remote = { address, port };
//     const remoteKey = this.toRemoteKey(unboundSession.remote);
//     this.remoteKeyToCallId.set(remoteKey, unboundSession.callId);
//     this.logger.log(
//       `RTP remote bound for call=${unboundSession.callId} remote=${address}:${port}`,
//     );

//     return unboundSession.callId;
//   }

//   private buildRtpPacket(session: RtpSession, payload: Buffer) {
//     const header = Buffer.alloc(12);
//     header[0] = 0x80;
//     header[1] = 0x00;

//     header.writeUInt16BE(session.txSequence, 2);
//     header.writeUInt32BE(session.txTimestamp, 4);
//     header.writeUInt32BE(session.ssrc, 8);

//     session.txSequence = (session.txSequence + 1) & 0xffff;
//     session.txTimestamp = (session.txTimestamp + payload.length) >>> 0;

//     return Buffer.concat([header, payload]);
//   }

//   private toRemoteKey(remote: RemoteEndpoint) {
//     return `${remote.address}:${remote.port}`;
//   }

//   private getBindHost() {
//     return (
//       this.configService.get<string>('ASTERISK_EXTERNAL_MEDIA_BIND_HOST') ||
//       '0.0.0.0'
//     );
//   }

//   private getBindPort() {
//     const fromConfig = this.configService.get<string>(
//       'ASTERISK_EXTERNAL_MEDIA_BIND_PORT',
//     );
//     if (fromConfig) {
//       const parsed = Number(fromConfig);
//       if (!Number.isNaN(parsed)) {
//         return parsed;
//       }
//     }

//     const externalHost =
//       this.configService.get<string>('ASTERISK_EXTERNAL_MEDIA_HOST') ||
//       '127.0.0.1:6000';
//     const parts = externalHost.split(':');
//     const parsed = Number(parts[parts.length - 1]);
//     if (!Number.isNaN(parsed)) {
//       return parsed;
//     }
//     return 6000;
//   }
// }
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import dgram, { RemoteInfo, Socket } from 'dgram';

// ─────────────────────────────────────────────────────────────────────────────
// RTP Payload Type for slin16 (signed linear PCM, 16kHz, 16-bit, mono).
//
// PT 10 is the standard IANA assignment for L16 mono @ 44.1kHz BUT Asterisk
// reuses PT 10 internally for slin16 when negotiated via the `slin16` codec
// name. The important thing is that both sides agree — this value must match
// what you set in pjsip.conf (allow=!all,slin16).
//
// If you ever see Asterisk logging "unsupported payload type" on inbound,
// check `asterisk -rx "core show codecs"` and match the PT shown there.
// ─────────────────────────────────────────────────────────────────────────────
const SLIN16_PAYLOAD_TYPE = 10;

type RemoteEndpoint = {
  address: string;
  port: number;
};

type RtpSession = {
  callId: string;
  remote?: RemoteEndpoint;
  packetsRx: number;
  bytesRx: number;
  lastPacketAt?: string;
  txSequence: number;
  txTimestamp: number;
  ssrc: number;
};

type AudioFrameHandler = (frame: {
  callId: string;
  payload: Buffer;
  sequenceNumber: number;
  timestamp: number;
  marker: boolean;
  payloadType: number;
}) => void;

@Injectable()
export class AriRtpMediaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AriRtpMediaService.name);
  private socket: Socket | null = null;
  private readonly sessions = new Map<string, RtpSession>();
  private readonly remoteKeyToCallId = new Map<string, string>();
  private onAudioFrameHandler: AudioFrameHandler | null = null;

  constructor(private readonly configService: ConfigService) { }

  onModuleInit() {
    this.startSocket();
  }

  onModuleDestroy() {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  getHealth() {
    return {
      listening: Boolean(this.socket),
      bindHost: this.getBindHost(),
      bindPort: this.getBindPort(),
      activeRtpSessions: this.sessions.size,
    };
  }

  setAudioFrameHandler(handler: AudioFrameHandler) {
    this.onAudioFrameHandler = handler;
  }

  registerCallSession(callId: string) {
    if (this.sessions.has(callId)) {
      return;
    }

    this.sessions.set(callId, {
      callId,
      packetsRx: 0,
      bytesRx: 0,
      txSequence: Math.floor(Math.random() * 65535),
      txTimestamp: Math.floor(Math.random() * 0xffffffff),
      ssrc: Math.floor(Math.random() * 0xffffffff),
    });

    this.logger.log(`RTP session registered for call=${callId}`);
  }

  unregisterCallSession(callId: string) {
    const session = this.sessions.get(callId);
    if (!session) {
      return;
    }

    if (session.remote) {
      this.remoteKeyToCallId.delete(this.toRemoteKey(session.remote));
    }

    this.sessions.delete(callId);
    this.logger.log(`RTP session unregistered for call=${callId}`);
  }

  /**
   * Send a raw slin16 PCM frame to Asterisk via RTP.
   *
   * Previously named sendUlawToCall. Renamed because:
   *   - Payload type is now PT 10 (slin16) instead of PT 0 (ulaw)
   *   - Timestamp increment is now payload.length / 2 (samples, not bytes)
   *     because slin16 = 2 bytes per sample @ 16kHz
   *   - No encoding is applied — caller passes raw 16-bit PCM directly
   *
   * Callers: VoiceService.startOutboundPacer()
   */
  sendSlin16ToCall(callId: string, pcmPayload: Buffer) {
    const session = this.sessions.get(callId);
    if (!session || !session.remote || !this.socket) {
      return;
    }

    const rtpPacket = this.buildRtpPacket(session, pcmPayload);
    this.socket.send(rtpPacket, session.remote.port, session.remote.address);
  }

  private startSocket() {
    if (this.socket) {
      return;
    }

    this.socket = dgram.createSocket('udp4');

    this.socket.on('message', (message: Buffer, remote: RemoteInfo) => {
      this.handleIncomingPacket(message, remote);
    });

    this.socket.on('error', (error) => {
      this.logger.error(`RTP socket error: ${error.message}`);
    });

    const host = this.getBindHost();
    const port = this.getBindPort();
    this.socket.bind(port, host, () => {
      this.logger.log(`RTP media socket listening on ${host}:${port}`);
    });
  }

  private handleIncomingPacket(packet: Buffer, remote: RemoteInfo) {
    if (packet.length < 12) {
      return;
    }

    const remoteKey = this.toRemoteKey({
      address: remote.address,
      port: remote.port,
    });
    let callId = this.remoteKeyToCallId.get(remoteKey);

    if (!callId) {
      callId = this.bindRemoteToPendingSession(remote.address, remote.port);
      if (!callId) {
        return;
      }
    }

    const session = this.sessions.get(callId);
    if (!session) {
      return;
    }

    const version = packet[0] >> 6;
    if (version !== 2) {
      return;
    }

    const marker = (packet[1] & 0x80) !== 0;
    const payloadType = packet[1] & 0x7f;

    // ── Accept slin16 (PT 10) inbound from Asterisk.
    // Previously this was `!== 0` (ulaw PT 0). Now we expect PT 10.
    // Asterisk will send comfort noise or other types on PT 13 etc —
    // silently drop anything that isn't our slin16 stream.
    if (payloadType !== SLIN16_PAYLOAD_TYPE) {
      return;
    }

    const sequenceNumber = packet.readUInt16BE(2);
    const timestamp = packet.readUInt32BE(4);

    const csrcCount = packet[0] & 0x0f;
    const headerLength = 12 + csrcCount * 4;
    if (packet.length < headerLength) {
      return;
    }

    const payload = packet.subarray(headerLength);
    session.packetsRx += 1;
    session.bytesRx += payload.length;
    session.lastPacketAt = new Date().toISOString();

    if (this.onAudioFrameHandler) {
      this.onAudioFrameHandler({
        callId,
        payload,
        sequenceNumber,
        timestamp,
        marker,
        payloadType,
      });
    }
  }

  private bindRemoteToPendingSession(
    address: string,
    port: number,
  ): string | undefined {
    const unboundSession = [...this.sessions.values()].find(
      (session) => !session.remote,
    );
    if (!unboundSession) {
      return undefined;
    }

    unboundSession.remote = { address, port };
    const remoteKey = this.toRemoteKey(unboundSession.remote);
    this.remoteKeyToCallId.set(remoteKey, unboundSession.callId);
    this.logger.log(
      `RTP remote bound for call=${unboundSession.callId} remote=${address}:${port}`,
    );

    return unboundSession.callId;
  }

  private buildRtpPacket(session: RtpSession, payload: Buffer) {
    const header = Buffer.alloc(12);

    // Byte 0: V=2, P=0, X=0, CC=0
    header[0] = 0x80;

    // Byte 1: M=0, PT=10 (slin16)
    // Previously 0x00 (PT 0 = ulaw). Now 0x0A (PT 10 = slin16).
    header[1] = SLIN16_PAYLOAD_TYPE;

    header.writeUInt16BE(session.txSequence, 2);
    header.writeUInt32BE(session.txTimestamp, 4);
    header.writeUInt32BE(session.ssrc, 8);

    session.txSequence = (session.txSequence + 1) & 0xffff;

    // ── Timestamp increment for slin16:
    // slin16 = 16-bit samples @ 16kHz → 2 bytes per sample.
    // RTP timestamp counts SAMPLES, not bytes.
    // So increment = payload.length (bytes) / 2 (bytes per sample) = sample count.
    //
    // Previously for ulaw: payload.length (1 byte per sample @ 8kHz, so bytes = samples).
    // Wrong increment would drift Asterisk's jitter buffer and cause choppy audio.
    session.txTimestamp = (session.txTimestamp + payload.length / 2) >>> 0;

    return Buffer.concat([header, payload]);
  }

  private toRemoteKey(remote: RemoteEndpoint) {
    return `${remote.address}:${remote.port}`;
  }

  private getBindHost() {
    return (
      this.configService.get<string>('ASTERISK_EXTERNAL_MEDIA_BIND_HOST') ||
      '0.0.0.0'
    );
  }

  private getBindPort() {
    const fromConfig = this.configService.get<string>(
      'ASTERISK_EXTERNAL_MEDIA_BIND_PORT',
    );
    if (fromConfig) {
      const parsed = Number(fromConfig);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }

    const externalHost =
      this.configService.get<string>('ASTERISK_EXTERNAL_MEDIA_HOST') ||
      '127.0.0.1:6000';
    const parts = externalHost.split(':');
    const parsed = Number(parts[parts.length - 1]);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
    return 6000;
  }
}