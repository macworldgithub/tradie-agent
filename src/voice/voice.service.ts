import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import axios from 'axios';
import { ClientRequest } from 'http';
import { Model } from 'mongoose';
import { Socket } from 'net';
import { TLSSocket } from 'tls';
import WebSocket from 'ws';
import { DidsService } from '../dids/dids.service';
import { TradiesService } from '../tradies/tradies.service';
import { SessionService } from '../session/session.service';
import { CallsService } from '../calls/calls.service';
import { AriRtpMediaService } from '../ari/ari-rtp-media.service';
import { VoiceMlBuilder } from './voiceml.builder';
import { Customer, CustomerDocument } from './Schema/customer.schema';
import { CallEventEmitter } from './call-event-emitter';
import SpeexResampler from 'speex-resampler'; // ← added this to make voice better

/**
 * RealtimeSession interface tracks the state of a single voice call.
 * This includes the connection to OpenAI (Brain) and ElevenLabs (Voice).
 */
interface RealtimeSession {
  ws: WebSocket; // Connection to OpenAI Realtime API
  elevenLabsWs: WebSocket | null; // Connection to ElevenLabs TTS API
  elevenLabsReady: boolean; // Becomes true when ElevenLabs is ready to talk
  textBuffer: string[]; // Holds text while ElevenLabs is still connecting
  isResponseActive: boolean; // Tracks if OpenAI is currently generating a response
  onEvent: (event: any) => void;
  sessionStartedAtMs: number;
  openAiConnectedAtMs: number | null;
  elevenLabsConnectedAtMs: number | null;
  greetingTriggeredAtMs: number | null;
  firstResponseCreatedAtMs: number | null;
  firstAudioDeltaLogged: boolean;
  processedFunctionCallIds: Set<string>;
  enfonicaCallId?: string | null;
  customerNumber?: string | null;
  didNumber?: string | null;
  currentContextId?: string | null;
  lastSpeechStartedAtMs?: number | null;
  lastSpeechStoppedAtMs?: number | null;
  lastResponseCreatedAtMs?: number | null;
  isFirstTextDeltaOfTurn?: boolean;
  lastTextDeltaReceivedAtMs?: number | null;
  firstAudioDeltaReceivedForContext?: boolean;

  // ───────────────────────────────────────────────────────────────────
  // FIX: RTP pacer state — queue + interval timer that drains one
  // 20ms μ-law frame at a time to match real-time audio cadence.
  // Without this, all RTP packets for a turn were blasted in a tight
  // for-loop, overflowing Asterisk's receive buffer and dropping the
  // tail of longer sentences (~70-75% point).
  // ───────────────────────────────────────────────────────────────────
  outboundFrameQueue: Buffer[];
  outboundPacerTimer: NodeJS.Timeout | null;
  resampler16to8: SpeexResampler | null;   // ← added these to make voice better
  resampler8to24: SpeexResampler | null;   // ← added these to make voice better
}

interface FunctionCallPayload {
  name: string;
  arguments: string;
  call_id: string;
}

// Each μ-law frame is 160 bytes = 160 samples @ 8kHz = 20ms of audio.
const ULAW_FRAME_BYTES = 160;
const ULAW_FRAME_INTERVAL_MS = 20;

@Injectable()
export class VoiceService {
  private readonly logger = new Logger(VoiceService.name);

  private sessions = new Map<string, RealtimeSession>();

  private toFunctionCallPayload(value: unknown): FunctionCallPayload | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const type = record.type;
    const name = record.name;
    const args = record.arguments;
    const callId = record.call_id;
    if (type !== 'function_call') return null;
    if (
      typeof name !== 'string' ||
      typeof args !== 'string' ||
      typeof callId !== 'string'
    ) {
      return null;
    }
    return { name, arguments: args, call_id: callId };
  }

  constructor(
    private readonly config: ConfigService,
    @InjectModel(Customer.name)
    private readonly customerModel: Model<CustomerDocument>,
    private readonly didsService: DidsService,
    private readonly tradiesService: TradiesService,
    private readonly sessionService: SessionService,
    private readonly callsService: CallsService,
    private readonly ariRtpMediaService: AriRtpMediaService,
    private readonly callEventEmitter: CallEventEmitter,
  ) { }

  async handleIncomingWebhook(
    payload: Record<string, unknown>,
  ): Promise<string> {
    const callSid = this.getStringValue(payload, [
      'callSid',
      'CallSid',
      'call_id',
      'callId',
    ]);
    const callerIdRaw = this.getStringValue(payload, [
      'from',
      'From',
      'callerId',
      'callerID',
    ]);
    const didRaw = this.getStringValue(payload, ['to', 'To', 'did', 'DID']);
    const timestamp = new Date().toISOString();

    this.logger.log(
      `Incoming webhook callSid=${callSid ?? 'unknown'} callerID=${callerIdRaw ?? 'unknown'} did=${didRaw ?? 'unknown'} timestamp=${timestamp}`,
    );

    if (!callSid || !callerIdRaw || !didRaw) {
      return VoiceMlBuilder.say(
        'We could not process your call at this time. Please try again later.',
      );
    }

    const callerID = this.ensureE164CallerId(callerIdRaw);
    this.sessionService.createSession({
      callSid,
      callerID,
      did: didRaw,
      timestamp,
    });

    const didRecord = await this.didsService.findByDidNumber(didRaw);
    if (!didRecord) {
      this.logger.warn(`DID lookup failed for did=${didRaw}`);
      return VoiceMlBuilder.say(
        'We could not connect your call right now. Please try again later.',
      );
    }

    const resolvedTradieId = didRecord.assignedTradieId || 
      (didRecord.assignedTradieIds && didRecord.assignedTradieIds.length > 0 ? didRecord.assignedTradieIds[0] : undefined);

    if (!resolvedTradieId) {
      this.logger.warn(`No tradie assigned to DID: ${didRaw}`);
      return VoiceMlBuilder.say(
        'We could not connect your call right now. Please try again later.',
      );
    }

    const tradie = await this.tradiesService.findById(String(resolvedTradieId));
    if (!tradie) {
      this.logger.warn(
        `Tradie lookup failed for did=${didRaw} tradieId=${resolvedTradieId}`,
      );
      return VoiceMlBuilder.say(
        'We could not connect your call right now. Please try again later.',
      );
    }

    this.logger.log(
      `DID lookup succeeded for did=${didRaw} tradie=${tradie.phoneNumber}`,
    );

    if (!this.isE164(tradie.phoneNumber)) {
      this.logger.warn(
        `Tradie phone number is not E164. tradie=${tradie.phoneNumber}`,
      );
      return VoiceMlBuilder.say(
        'We could not connect your call right now. Please try again later.',
      );
    }

    this.sessionService.updateSession(callSid, {
      tradieNumber: tradie.phoneNumber,
      companyId: didRecord.companyId,
    });

    const nextUri = this.buildAbsoluteUrl('/voice/callback');
    if (!nextUri) {
      return VoiceMlBuilder.say(
        'We could not connect your call right now. Please try again later.',
      );
    }
    return VoiceMlBuilder.dialTradie({
      callerId: callerID,
      tradieNumber: tradie.phoneNumber,
      nextUri,
      timeoutSeconds: 15,
    });
  }

  async handleCallbackWebhook(
    payload: Record<string, unknown>,
  ): Promise<string> {
    const callSid = this.getStringValue(payload, [
      'callSid',
      'CallSid',
      'call_id',
      'callId',
    ]);
    const callStatusRaw = this.getStringValue(payload, [
      'callStatus',
      'CallStatus',
      'status',
    ]);

    this.logger.log(
      `Callback webhook callSid=${callSid ?? 'unknown'} callStatus=${callStatusRaw ?? 'unknown'}`,
    );

    if (callSid && callStatusRaw) {
      this.sessionService.updateCallStatus(callSid, callStatusRaw);
    }

    const session = callSid
      ? this.sessionService.getSession(callSid)
      : undefined;
    const callerIdRaw =
      session?.callerID ||
      this.getStringValue(payload, ['from', 'From', 'callerId', 'callerID']) ||
      '';
    const did =
      session?.did ||
      this.getStringValue(payload, ['to', 'To', 'did', 'DID']) ||
      '';

    const callStatus = (callStatusRaw || '').toUpperCase();
    if (callStatus !== 'COMPLETED') {
      await this.triggerAriFallback(callSid, callerIdRaw, did);
    }

    return VoiceMlBuilder.say(
      'Please hold while we connect you to our virtual assistant.',
    );
  }

  private async triggerAriFallback(
    callSid: string | undefined,
    callerIdRaw: string,
    did: string,
  ): Promise<void> {
    const ariUrl = this.config.get<string>('ASTERISK_ARI_URL');
    const username =
      this.config.get<string>('ASTERISK_ARI_USER') ||
      this.config.get<string>('ASTERISK_ARI_USERNAME');
    const password =
      this.config.get<string>('ASTERISK_ARI_PASS') ||
      this.config.get<string>('ASTERISK_ARI_PASSWORD');
    const context = this.config.get<string>('ASTERISK_CONTEXT');
    const extension = this.config.get<string>('ASTERISK_EXTENSION');
    const app = this.config.get<string>('ASTERISK_ARI_APP');

    if (!ariUrl || !username || !password) {
      this.logger.error(
        `ARI fallback skipped due to missing credentials callSid=${callSid ?? 'unknown'}`,
      );
      return;
    }
    if (!extension || !context) {
      this.logger.error(
        `ARI fallback skipped due to missing context/extension callSid=${callSid ?? 'unknown'}`,
      );
      return;
    }

    const callerId = this.ensureE164CallerId(callerIdRaw);
    const endpoint = `Local/${extension}@${context}`;
    const url = `${ariUrl.replace(/\/+$/, '')}/ari/channels`;
    const params: Record<string, string> = {
      endpoint,
      callerId,
      timeout: '15',
      variables: JSON.stringify({ CALLER_ID: callerId, DID: did }),
    };
    if (app) params.app = app;

    try {
      const response = await axios.post(url, null, {
        auth: { username, password },
        params,
      });
      this.logger.log(
        `Fallback triggered callSid=${callSid ?? 'unknown'} callerID=${callerId} did=${did} ariStatus=${response.status}`,
      );
    } catch (error) {
      const status = (error as { response?: { status?: number } }).response
        ?.status;
      this.logger.error(
        `Fallback trigger failed callSid=${callSid ?? 'unknown'} callerID=${callerId} did=${did} ariStatus=${status ?? 'unknown'}`,
      );
    }
  }

  private buildAbsoluteUrl(path: string): string {
    const baseUrl = this.config.get<string>('BASE_URL');
    if (!baseUrl) {
      this.logger.error('BASE_URL is not set; cannot build NextUri.');
      return '';
    }
    const normalizedBase = baseUrl.replace(/\/+$/, '');
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${normalizedBase}${normalizedPath}`;
  }

  private ensureE164CallerId(value: string): string {
    if (this.isE164(value)) return value;
    const fallback = this.config.get<string>('DEFAULT_CALLER_ID') || '';
    if (this.isE164(fallback)) {
      this.logger.warn(
        `CallerID invalid, using DEFAULT_CALLER_ID instead. callerID=${value}`,
      );
      return fallback;
    }
    this.logger.warn(`CallerID invalid and DEFAULT_CALLER_ID missing.`);
    return value;
  }

  private isE164(value: string): boolean {
    return /^\+[1-9]\d{7,14}$/.test(value);
  }

  private getStringValue(
    payload: Record<string, unknown>,
    keys: string[],
  ): string | undefined {
    for (const key of keys) {
      const value = payload[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
    }
    return undefined;
  }

  async handleIncomingCall(
    channel: {
      id?: string;
      caller?: { number?: string };
      connected?: { number?: string };
      call_id?: string;
      caller_number?: string;
      called_number?: string;
    },
    enfonicaCallId: string | null,
    customerNumber: string | null,
    didNumber: string | null,
  ) {
    const callId = channel.id || channel.call_id || '';
    const callerNumber =
      customerNumber || channel.caller?.number || channel.caller_number || null;
    const calledNumber =
      didNumber || channel.connected?.number || channel.called_number || null;

    if (!callId) {
      this.logger.error('Voice Service handling call: missing call_id');
      return { success: false, error: 'Missing call_id' };
    }

    this.logger.log(`Voice Service handling call: ${callId}`);

    let resolvedEnfonicaCallId = enfonicaCallId;
    if (!resolvedEnfonicaCallId && callerNumber) {
      try {
        const matchingLog = await this.callsService.findLatestByCaller(callerNumber);
        if (matchingLog) {
          resolvedEnfonicaCallId = matchingLog.enfonicaCallId ?? null;
          this.logger.log(
            `[${callId}] Linked Asterisk call to Enfonica Call ID: ${resolvedEnfonicaCallId} via caller number: ${callerNumber}`,
          );
        }
      } catch (err) {
        this.logger.error(`Failed to lookup matching CallLog by caller number: ${err.message}`);
      }
    }

    try {
      await this.createRealtimeSession(callId, async (event) => {
        this.logger.log(`[${callId}] Voice event: ${event.type}`);
        if (event.type === 'audio-delta') {
          this.sendAudioToAri(callId, event.delta);
        }
      }, callerNumber);

      const session = this.sessions.get(callId);
      if (session) {
        session.enfonicaCallId = resolvedEnfonicaCallId;
        session.customerNumber = callerNumber;
        session.didNumber = calledNumber;
      }

      this.triggerGreeting(callId);

      return {
        success: true,
        message: 'Voice session created successfully',
        call_id: callId,
      };
    } catch (error) {
      this.logger.error(`Error in Voice call handling: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * ───────────────────────────────────────────────────────────────────
   * FIX: Audio path now ENQUEUES μ-law frames instead of blasting them.
   *
   * Previously every RTP chunk for a turn was sent in a synchronous
   * for-loop with no pacing. For a long sentence (~6 seconds) that's
   * ~300 RTP packets fired in microseconds — a firehose into Asterisk's
   * UDP receive buffer. The buffer overflows and Asterisk silently
   * drops the tail of the audio. Short sentences fit in the buffer and
   * play fine; longer sentences cut at ~70-75% — exactly the symptom.
   *
   * Now we split into 20ms frames, queue them per session, and a single
   * pacer interval drains one frame every 20ms — matching real-time
   * audio cadence so Asterisk never sees a burst.
   * ───────────────────────────────────────────────────────────────────
   */
  // private sendAudioToAri(callId: string, audioDelta: string): void {
  //   try {
  //     const session = this.sessions.get(callId);
  //     if (!session) {
  //       this.logger.warn(
  //         `[${callId}] sendAudioToAri: no session — dropping audio`,
  //       );
  //       return;
  //     }

  //     const pcm16kBuffer = Buffer.from(audioDelta, 'base64');
  //     this.logger.debug(
  //       `[${callId}] sendAudioToAri: received ${pcm16kBuffer.length} bytes from ElevenLabs`,
  //     );

  //     const pcm8kBuffer = this.downsample16kTo8k(pcm16kBuffer);
  //     const ulawBuffer = this.convertPcm16ToUlaw(pcm8kBuffer);
  //     this.logger.debug(
  //       `[${callId}] sendAudioToAri: converted to ${ulawBuffer.length} ulaw bytes, queueing`,
  //     );

  //     // Split into 20ms frames and enqueue
  //     let frameCount = 0;
  //     for (let i = 0; i < ulawBuffer.length; i += ULAW_FRAME_BYTES) {
  //       const frame = ulawBuffer.subarray(i, i + ULAW_FRAME_BYTES);
  //       // Only queue full-size frames; trailing partial frame (rare) is also queued
  //       // since Asterisk tolerates short final frames.
  //       session.outboundFrameQueue.push(Buffer.from(frame));
  //       frameCount++;
  //     }

  //     this.logger.debug(
  //       `[${callId}] sendAudioToAri: queued ${frameCount} frames, ` +
  //       `queueDepth=${session.outboundFrameQueue.length}`,
  //     );

  //     // Kick the pacer if not running
  //     this.startOutboundPacer(callId);
  //   } catch (err) {
  //     this.logger.error(
  //       `[${callId}] sendAudioToAri FAILED: ${(err as Error).message}`,
  //       err,
  //     );
  //   }
  // }

  private async sendAudioToAri(callId: string, audioDelta: string): Promise<void> {
    try {
      const session = this.sessions.get(callId);
      if (!session) {
        this.logger.warn(`[${callId}] sendAudioToAri: no session — dropping audio`);
        return;
      }

      const pcm16kBuffer = Buffer.from(audioDelta, 'base64');
      this.logger.debug(`[${callId}] sendAudioToAri: received ${pcm16kBuffer.length} bytes from ElevenLabs`);

      const pcm8kBuffer = await this.downsample16kTo8k(callId, pcm16kBuffer);  // ← NOW ASYNC + sessionId
      const ulawBuffer = this.convertPcm16ToUlaw(pcm8kBuffer);
      this.logger.debug(`[${callId}] sendAudioToAri: converted to ${ulawBuffer.length} ulaw bytes, queueing`);

      let frameCount = 0;
      for (let i = 0; i < ulawBuffer.length; i += ULAW_FRAME_BYTES) {
        const frame = ulawBuffer.subarray(i, i + ULAW_FRAME_BYTES);
        session.outboundFrameQueue.push(Buffer.from(frame));
        frameCount++;
      }

      this.logger.debug(
        `[${callId}] sendAudioToAri: queued ${frameCount} frames, queueDepth=${session.outboundFrameQueue.length}`,
      );

      this.startOutboundPacer(callId);
    } catch (err) {
      this.logger.error(`[${callId}] sendAudioToAri FAILED: ${(err as Error).message}`, err);
    }
  }

  /**
   * Starts the per-session RTP pacer if it is not already running.
   * The pacer emits one 20ms μ-law frame per tick to match real-time
   * audio cadence. Auto-stops when the queue empties.
   */
  private startOutboundPacer(callId: string): void {
    const session = this.sessions.get(callId);
    if (!session) return;
    if (session.outboundPacerTimer) return; // already running

    session.outboundPacerTimer = setInterval(() => {
      const s = this.sessions.get(callId);
      if (!s) {
        // Session vanished — stop the pacer
        this.stopOutboundPacer(callId);
        return;
      }

      const frame = s.outboundFrameQueue.shift();
      if (!frame) {
        // Queue drained — stop pacer until next audio arrives
        this.stopOutboundPacer(callId);
        return;
      }

      try {
        this.ariRtpMediaService.sendUlawToCall(callId, frame);
      } catch (err) {
        this.logger.error(
          `[${callId}] Pacer send failed: ${(err as Error).message}`,
        );
      }
    }, ULAW_FRAME_INTERVAL_MS);
  }

  /**
   * Stops the per-session pacer interval. Safe to call when no pacer
   * is running.
   */
  private stopOutboundPacer(callId: string): void {
    const session = this.sessions.get(callId);
    if (!session) return;
    if (session.outboundPacerTimer) {
      clearInterval(session.outboundPacerTimer);
      session.outboundPacerTimer = null;
    }
  }

  /**
   * Clears any queued frames AND stops the pacer. Used on barge-in
   * so the bot stops talking immediately instead of finishing what
   * was already buffered.
   */
  private flushOutboundAudio(callId: string): void {
    const session = this.sessions.get(callId);
    if (!session) return;
    const dropped = session.outboundFrameQueue.length;
    session.outboundFrameQueue = [];
    this.stopOutboundPacer(callId);
    if (dropped > 0) {
      this.logger.log(
        `[${callId}] Outbound audio flushed: dropped ${dropped} queued frames`,
      );
    }
  }

  // private downsample16kTo8k(input: Buffer): Buffer {
  //   const inputSamples = input.length / 2;
  //   const outputSamples = Math.floor(inputSamples / 2);
  //   const output = Buffer.alloc(outputSamples * 2);

  //   for (let i = 0; i < outputSamples; i++) {
  //     const s1 = input.readInt16LE(i * 4);
  //     const s2 = input.readInt16LE(i * 4 + 2);
  //     const avg = Math.round((s1 + s2) / 2);
  //     const clamped = Math.max(-32768, Math.min(32767, avg));
  //     output.writeInt16LE(clamped, i * 2);
  //   }
  //   return output;
  // }
  private async downsample16kTo8k(sessionId: string, input: Buffer): Promise<Buffer> {
    const session = this.sessions.get(sessionId);
    if (!session) return Buffer.alloc(0);

    await SpeexResampler.initPromise;

    if (!session.resampler16to8) {
      session.resampler16to8 = new SpeexResampler(1, 16000, 8000, 8);
    }

    return session.resampler16to8.processChunk(input);
  }
  private convertPcm16ToUlaw(pcmBuffer: Buffer): Buffer {
    const ulaw = Buffer.alloc(pcmBuffer.length / 2);
    for (let i = 0; i < ulaw.length; i++) {
      const sample = pcmBuffer.readInt16LE(i * 2);
      ulaw[i] = this.linearToUlaw(sample);
    }
    return ulaw;
  }

  // private linearToUlaw(sample: number): number {
  //   const BIAS = 0x84;
  //   const CLIP = 32635;
  //   let sign = 0;
  //   if (sample < 0) {
  //     sample = -sample;
  //     sign = 0x80;
  //   }
  //   if (sample > CLIP) sample = CLIP;
  //   sample += BIAS;
  //   const exponent = Math.floor(Math.log2(sample)) - 6;
  //   const mantissa = (sample >> (exponent + 1)) & 0x0f;
  //   const ulawByte = ~(sign | (exponent << 4) | mantissa) & 0xff;
  //   return ulawByte;
  // }
  private linearToUlaw(sample: number): number {
    const BIAS = 0x84;
    const CLIP = 32635;
    let sign = 0;
    if (sample < 0) {
      sample = -sample;
      sign = 0x80;
    }
    if (sample > CLIP) sample = CLIP;
    sample += BIAS;
    let exponent = 7;
    for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) { }
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    return (~(sign | (exponent << 4) | mantissa)) & 0xff;
  }

  async createRealtimeSession(
    sessionId: string,
    onEvent: (event: any) => void,
    callerNumber?: string | null,
  ): Promise<void> {
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    const model =
      this.config.get<string>('OPENAI_REALTIME_MODEL') || 'gpt-realtime-2';
    const url = `wss://api.openai.com/v1/realtime?model=${model}`;
    const sessionStartedAtMs = Date.now();

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      this.instrumentClientWebSocketHandshake(
        sessionId,
        'OpenAI',
        ws,
        sessionStartedAtMs,
      );

      ws.on('open', () => {
        const openAiConnectedAtMs = Date.now();
        this.logger.log(`[${sessionId}] OpenAI Realtime WebSocket connected`);
        this.logger.log(
          `[${sessionId}] Timing: OpenAI WS connected in ${openAiConnectedAtMs - sessionStartedAtMs}ms`,
        );

        const sessionUpdate = {
          type: 'session.update',
          session: {
            type: 'realtime',
            model,
            output_modalities: ['text'],
            audio: {
              input: {
                format: { type: 'audio/pcm', rate: 24000 },
                turn_detection: {
                  type: 'server_vad',
                  threshold: 0.7,
                  prefix_padding_ms: 300,
                  silence_duration_ms: 1000,
                },
              },
            },
            instructions: this.getSystemPrompt(callerNumber),
            tools: [this.getSaveBookingTool()],
            tool_choice: 'auto',
          },
        };

        ws.send(JSON.stringify(sessionUpdate));

        this.sessions.set(sessionId, {
          ws,
          elevenLabsWs: null,
          elevenLabsReady: false,
          textBuffer: [],
          isResponseActive: false,
          onEvent,
          sessionStartedAtMs,
          openAiConnectedAtMs,
          elevenLabsConnectedAtMs: null,
          greetingTriggeredAtMs: null,
          firstResponseCreatedAtMs: null,
          firstAudioDeltaLogged: false,
          processedFunctionCallIds: new Set<string>(),
          // FIX: initialize pacer state
          outboundFrameQueue: [],
          outboundPacerTimer: null,
          resampler16to8: null, // ← added this to make voice better
          resampler8to24: null, // ← added this to make voice better
        });

        this.openElevenLabsStream(sessionId);
        resolve();
      });

      ws.on('message', async (data: WebSocket.Data) => {
        try {
          const event = JSON.parse(data.toString());
          await this.handleRealtimeEvent(sessionId, event);
        } catch (err) {
          this.logger.error(`[${sessionId}] Failed to parse event:`, err);
        }
      });

      ws.on('error', (err) => {
        this.logger.error(`[${sessionId}] OpenAI WebSocket error:`, err);
        onEvent({ type: 'error', error: { message: err.message } });
        reject(err);
      });

      ws.on('close', (code, reason) => {
        this.logger.log(
          `[${sessionId}] OpenAI WebSocket closed: ${code} - ${reason}`,
        );
        this.stopOutboundPacer(sessionId);
        this.closeElevenLabsWs(sessionId);
        this.sessions.delete(sessionId);
        onEvent({ type: 'session-closed' });
      });
    });
  }

  sendAudio(sessionId: string, base64Audio: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.ws.send(
      JSON.stringify({ type: 'input_audio_buffer.append', audio: base64Audio }),
    );
  }

  // sendInboundAudio(sessionId: string, ulawPayload: Buffer): void {
  //   const session = this.sessions.get(sessionId);
  //   if (!session || !session.ws || session.ws.readyState !== WebSocket.OPEN) {
  //     return;
  //   }
  //   try {
  //     const pcm8k = this.convertUlawToSlin(ulawPayload);
  //     const pcm24k = this.upsample8kTo24k(pcm8k);
  //     session.ws.send(
  //       JSON.stringify({
  //         type: 'input_audio_buffer.append',
  //         audio: pcm24k.toString('base64'),
  //       }),
  //     );
  //   } catch (err) {
  //     this.logger.error(
  //       `[${sessionId}] sendInboundAudio failed: ${(err as Error).message}`,
  //     );
  //   }
  // }

  async sendInboundAudio(sessionId: string, ulawPayload: Buffer): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.ws || session.ws.readyState !== WebSocket.OPEN) return;

    try {
      const pcm8k = this.convertUlawToSlin(ulawPayload);
      const pcm24k = await this.upsample8kTo24k(sessionId, pcm8k);  // ← NOW ASYNC + sessionId
      session.ws.send(
        JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: pcm24k.toString('base64'),
        }),
      );
    } catch (err) {
      this.logger.error(`[${sessionId}] sendInboundAudio failed: ${(err as Error).message}`);
    }
  }

  private convertUlawToSlin(ulawBuffer: Buffer): Buffer {
    const slinBuffer = Buffer.alloc(ulawBuffer.length * 2);
    for (let i = 0; i < ulawBuffer.length; i++) {
      const sample = this.ulawToLinear(ulawBuffer[i]);
      slinBuffer.writeInt16LE(sample, i * 2);
    }
    return slinBuffer;
  }

  // private ulawToLinear(ulaw: number): number {
  //   const BIAS = 0x84;
  //   ulaw = ~ulaw & 0xff;
  //   const sign = ulaw & 0x80;
  //   const exponent = (ulaw >> 4) & 0x07;
  //   const mantissa = ulaw & 0x0f;
  //   let sample = (mantissa << 3) + BIAS;
  //   sample <<= exponent;
  //   if (sign !== 0) sample = -sample;
  //   return sample;
  // }
  private ulawToLinear(ulaw: number): number {
    ulaw = ~ulaw & 0xff;
    const sign = ulaw & 0x80;
    const exponent = (ulaw >> 4) & 0x07;
    const mantissa = ulaw & 0x0f;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample -= 0x84;  // ← the missing step
    return sign !== 0 ? -sample : sample;
  }

  // private upsample8kTo24k(input: Buffer): Buffer {
  //   const inputSamples = input.length / 2;
  //   const outputSamples = inputSamples * 3;
  //   const output = Buffer.alloc(outputSamples * 2);
  //   for (let i = 0; i < inputSamples; i++) {
  //     const sample = input.readInt16LE(i * 2);
  //     const outIndex = i * 3;
  //     output.writeInt16LE(sample, outIndex * 2);
  //     output.writeInt16LE(sample, (outIndex + 1) * 2);
  //     output.writeInt16LE(sample, (outIndex + 2) * 2);
  //   }
  //   return output;
  // }
  private async upsample8kTo24k(sessionId: string, input: Buffer): Promise<Buffer> {
    const session = this.sessions.get(sessionId);
    if (!session) return Buffer.alloc(0);

    await SpeexResampler.initPromise;

    if (!session.resampler8to24) {
      session.resampler8to24 = new SpeexResampler(1, 8000, 24000, 8);
    }

    return session.resampler8to24.processChunk(input);
  }

  triggerGreeting(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.greetingTriggeredAtMs = Date.now();
    this.logger.log(
      `[${sessionId}] Timing: greeting trigger fired at ${session.greetingTriggeredAtMs - session.sessionStartedAtMs}ms from session start`,
    );
    session.ws.send(JSON.stringify({ type: 'response.create' }));
  }

  private openElevenLabsStream(sessionId: string, force = false): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (
      !force &&
      session.elevenLabsWs &&
      (session.elevenLabsWs.readyState === WebSocket.OPEN ||
        session.elevenLabsWs.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.closeElevenLabsWs(sessionId);

    const apiKey = this.config.get<string>('ELEVENLABS_API_KEY');
    const voiceId = this.config.get<string>('ELEVENLABS_VOICE_ID');
    const wsUrl = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/multi-stream-input?model_id=eleven_flash_v2_5&output_format=pcm_16000&inactivity_timeout=180`;

    const elWs = new WebSocket(wsUrl);
    this.instrumentClientWebSocketHandshake(
      sessionId,
      'ElevenLabs',
      elWs,
      session.sessionStartedAtMs,
    );

    elWs.on('open', () => {
      this.logger.log(`[${sessionId}] ElevenLabs WebSocket connected`);
      session.elevenLabsConnectedAtMs = Date.now();
      this.logger.log(
        `[${sessionId}] Timing: ElevenLabs WS connected in ${session.elevenLabsConnectedAtMs - session.sessionStartedAtMs}ms`,
      );

      elWs.send(
        JSON.stringify({
          text: ' ',
          voice_settings: {
            stability: 0.4,
            similarity_boost: 0.75,
            speed: 1.0,
          },
          xi_api_key: apiKey,
        }),
      );

      if (session.elevenLabsWs === elWs) {
        session.elevenLabsReady = true;
        for (const text of session.textBuffer) {
          this.sendTextToElevenLabs(sessionId, text);
        }
        session.textBuffer = [];
      }
    });

    elWs.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.audio) {
          const msgContextId = msg.contextId || msg.context_id;
          this.logger.debug(
            `[${sessionId}] EL chunk received: contextId=${msgContextId} ` +
            `currentCtx=${session.currentContextId} ` +
            `isFinal=${msg.isFinal ?? msg.is_final ?? false} ` +
            `audioBytes=${Buffer.from(msg.audio, 'base64').length}`,
          );
          if (
            session.currentContextId &&
            msgContextId !== session.currentContextId
          ) {
            this.logger.debug(
              `[${sessionId}] Discarding late audio chunk from old context: ${msgContextId}`,
            );
            return;
          }

          if (!session.firstAudioDeltaReceivedForContext) {
            session.firstAudioDeltaReceivedForContext = true;
            const now = Date.now();
            const fromSpeechStopped = session.lastSpeechStoppedAtMs
              ? `${now - session.lastSpeechStoppedAtMs}ms`
              : 'N/A';
            const fromResponseCreated = session.lastResponseCreatedAtMs
              ? `${now - session.lastResponseCreatedAtMs}ms`
              : 'N/A';
            const fromFirstTextDelta = session.lastTextDeltaReceivedAtMs
              ? `${now - session.lastTextDeltaReceivedAtMs}ms`
              : 'N/A';
            this.logger.log(
              `[${sessionId}] Turn Latency Breakdown:\n` +
              `  - User stopped speaking -> First Audio Chunk: ${fromSpeechStopped}\n` +
              `  - OpenAI Response Created -> First Audio Chunk: ${fromResponseCreated}\n` +
              `  - OpenAI Text Generated -> ElevenLabs Audio Received: ${fromFirstTextDelta}`,
            );
          }

          if (!session.firstAudioDeltaLogged) {
            const firstAudioAtMs = Date.now();
            session.firstAudioDeltaLogged = true;
            const openAiMs = session.openAiConnectedAtMs
              ? session.openAiConnectedAtMs - session.sessionStartedAtMs
              : -1;
            const elevenLabsMs = session.elevenLabsConnectedAtMs
              ? session.elevenLabsConnectedAtMs - session.sessionStartedAtMs
              : -1;
            const greetingMs = session.greetingTriggeredAtMs
              ? session.greetingTriggeredAtMs - session.sessionStartedAtMs
              : -1;
            const responseCreatedAfterGreetingMs =
              session.firstResponseCreatedAtMs && session.greetingTriggeredAtMs
                ? session.firstResponseCreatedAtMs -
                session.greetingTriggeredAtMs
                : -1;
            const firstAudioAfterResponseCreatedMs =
              session.firstResponseCreatedAtMs
                ? firstAudioAtMs - session.firstResponseCreatedAtMs
                : -1;
            this.logger.log(
              `[${sessionId}] Timing: first audio delta at ${firstAudioAtMs - session.sessionStartedAtMs}ms ` +
              `(openai=${openAiMs}ms, elevenlabs=${elevenLabsMs}ms, greeting=${greetingMs}ms, ` +
              `response_created_after_greeting=${responseCreatedAfterGreetingMs}ms, audio_after_response_created=${firstAudioAfterResponseCreatedMs}ms)`,
            );
          }
          session.onEvent({ type: 'audio-delta', delta: msg.audio });
        }
      } catch (err) { }
    });

    elWs.on('error', (err) => {
      this.logger.warn(`[${sessionId}] ElevenLabs WS error: ${err.message}`);
    });

    elWs.on('close', (code, reason) => {
      this.logger.warn(
        `[${sessionId}] ElevenLabs WS closed: code=${code} reason=${reason?.toString()}`,
      );
      clearInterval(keepaliveInterval);
      if (session.elevenLabsWs === elWs) {
        session.elevenLabsReady = false;
      }
    });

    const keepaliveInterval = setInterval(() => {
      const s = this.sessions.get(sessionId);
      if (
        !s ||
        !s.elevenLabsWs ||
        s.elevenLabsWs !== elWs ||
        s.elevenLabsWs.readyState !== WebSocket.OPEN
      ) {
        clearInterval(keepaliveInterval);
        return;
      }
      try {
        const payload: any = { text: ' ' };
        if (s.currentContextId) payload.context_id = s.currentContextId;
        s.elevenLabsWs.send(JSON.stringify(payload));
      } catch { }
    }, 10000);

    session.elevenLabsWs = elWs;
  }

  private instrumentClientWebSocketHandshake(
    sessionId: string,
    provider: 'OpenAI' | 'ElevenLabs',
    ws: WebSocket,
    startedAtMs: number,
  ): void {
    const wsWithReq = ws as WebSocket & { _req?: ClientRequest };
    const req = wsWithReq._req;
    if (!req) {
      this.logger.warn(
        `[${sessionId}] Timing: ${provider} request object not available for low-level socket timings`,
      );
      return;
    }

    let socketHooksAttached = false;
    const attachSocketHooks = (socket: Socket): void => {
      if (socketHooksAttached) return;
      socketHooksAttached = true;
      socket.once('lookup', () =>
        this.logger.log(
          `[${sessionId}] Timing: ${provider} DNS lookup completed in ${Date.now() - startedAtMs}ms`,
        ),
      );
      socket.once('connect', () =>
        this.logger.log(
          `[${sessionId}] Timing: ${provider} TCP connect completed in ${Date.now() - startedAtMs}ms`,
        ),
      );
      (socket as TLSSocket).once('secureConnect', () =>
        this.logger.log(
          `[${sessionId}] Timing: ${provider} TLS handshake completed in ${Date.now() - startedAtMs}ms`,
        ),
      );
    };

    if (req.socket) attachSocketHooks(req.socket);
    req.once('socket', (socket: Socket) => attachSocketHooks(socket));
    ws.on('upgrade', () =>
      this.logger.log(
        `[${sessionId}] Timing: ${provider} WS upgrade completed in ${Date.now() - startedAtMs}ms`,
      ),
    );
    ws.on('open', () =>
      this.logger.log(
        `[${sessionId}] Timing: ${provider} WS open event at ${Date.now() - startedAtMs}ms`,
      ),
    );
  }

  private sendTextToElevenLabs(sessionId: string, text: string): void {
    const session = this.sessions.get(sessionId);
    if (
      !session?.elevenLabsReady ||
      session.elevenLabsWs?.readyState !== WebSocket.OPEN
    ) {
      this.logger.warn(
        `[${sessionId}] sendTextToElevenLabs DROPPED: ` +
        `ready=${session?.elevenLabsReady} ` +
        `wsState=${session?.elevenLabsWs?.readyState} ` +
        `text="${text?.substring(0, 30)}"`,
      );
      return;
    }
    if (!session.currentContextId) {
      session.currentContextId = `ctx_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    }
    session.elevenLabsWs.send(
      JSON.stringify({
        text,
        context_id: session.currentContextId,
        try_trigger_generation: true,
      }),
    );
  }

  private flushElevenLabsStream(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (
      session.elevenLabsWs &&
      session.elevenLabsWs.readyState === WebSocket.OPEN &&
      session.currentContextId
    ) {
      try {
        session.elevenLabsWs.send(
          JSON.stringify({
            text: ' ',
            context_id: session.currentContextId,
            flush: true,
          }),
        );
      } catch { }
    }
  }

  private closeElevenLabsWs(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.elevenLabsWs) {
      try {
        if (session.elevenLabsWs.readyState === WebSocket.CONNECTING)
          session.elevenLabsWs.terminate();
        else if (session.elevenLabsWs.readyState === WebSocket.OPEN)
          session.elevenLabsWs.close();
      } catch (err) {
        this.logger.warn(
          `[${sessionId}] Error closing ElevenLabs WS: ${err.message}`,
        );
      }
      session.elevenLabsWs = null;
      session.elevenLabsReady = false;
      session.textBuffer = [];
      session.currentContextId = null;
    }
  }

  private async handleRealtimeEvent(
    sessionId: string,
    event: any,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.logger.debug(`[${sessionId}] OpenAI Debug Event: ${event.type}`);

    switch (event.type) {
      case 'response.created':
        session.isResponseActive = true;
        session.lastResponseCreatedAtMs = Date.now();
        session.isFirstTextDeltaOfTurn = true;
        session.firstAudioDeltaReceivedForContext = false;

        if (session.lastSpeechStoppedAtMs) {
          const vadDelay = Date.now() - session.lastSpeechStoppedAtMs;
          this.logger.log(
            `[${sessionId}] Timing: VAD (silence detection) + network handshake delay took ${vadDelay}ms`,
          );
        }

        if (!session.firstResponseCreatedAtMs) {
          session.firstResponseCreatedAtMs = Date.now();
          const fromSessionStart =
            session.firstResponseCreatedAtMs - session.sessionStartedAtMs;
          const fromGreeting = session.greetingTriggeredAtMs
            ? session.firstResponseCreatedAtMs - session.greetingTriggeredAtMs
            : -1;
          this.logger.log(
            `[${sessionId}] Timing: first response.created at ${fromSessionStart}ms (after greeting=${fromGreeting}ms)`,
          );
        }

        if (
          session.currentContextId &&
          session.elevenLabsWs?.readyState === WebSocket.OPEN
        ) {
          try {
            session.elevenLabsWs.send(
              JSON.stringify({
                context_id: session.currentContextId,
                close_context: true,
              }),
            );
          } catch { }
        }

        session.currentContextId = `ctx_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        this.openElevenLabsStream(sessionId);
        break;

      case 'response.done':
        session.isResponseActive = false;
        {
          const typedEvent = event as { response?: { output?: unknown } };
          const outputs = typedEvent.response?.output;
          if (Array.isArray(outputs)) {
            for (const item of outputs) {
              const functionCall = this.toFunctionCallPayload(item);
              if (functionCall)
                await this.handleFunctionCall(sessionId, functionCall);
            }
          }
        }
        break;

      case 'response.output_text.delta':
      case 'response.text.delta':
        this.logger.debug(
          `[${sessionId}] Text delta: elevenLabsReady=${session.elevenLabsReady} ` +
          `wsState=${session.elevenLabsWs?.readyState} ` +
          `bufferSize=${session.textBuffer.length} ` +
          `text="${event.delta?.substring(0, 20)}..."`,
        );
        if (
          !session.elevenLabsReady &&
          session.elevenLabsWs?.readyState === WebSocket.OPEN
        ) {
          session.elevenLabsReady = true;
        }

        if (session.isFirstTextDeltaOfTurn) {
          session.isFirstTextDeltaOfTurn = false;
          session.lastTextDeltaReceivedAtMs = Date.now();
          if (session.lastResponseCreatedAtMs) {
            const timeToFirstText =
              Date.now() - session.lastResponseCreatedAtMs;
            this.logger.log(
              `[${sessionId}] Timing: OpenAI response generation delay (time to first text) took ${timeToFirstText}ms`,
            );
          }
        }

        if (session.elevenLabsReady) {
          this.sendTextToElevenLabs(sessionId, event.delta);
        } else {
          session.textBuffer.push(event.delta);
        }
        session.onEvent({ type: 'transcript-delta', delta: event.delta });
        break;

      case 'response.output_text.done':
      case 'response.text.done':
        this.flushElevenLabsStream(sessionId);
        session.onEvent({ type: 'transcript-done', transcript: event.text });
        break;

      case 'input_audio_buffer.speech_started':
        session.lastSpeechStartedAtMs = Date.now();
        this.logger.log(`[${sessionId}] USER INTERRUPTED -> Stopping AI Voice`);

        // FIX: also flush queued outbound RTP frames so the bot stops
        // talking immediately on barge-in (was previously continuing
        // to play whatever was already buffered).
        this.flushOutboundAudio(sessionId);

        if (session.isResponseActive) {
          try {
            session.ws.send(JSON.stringify({ type: 'response.cancel' }));
          } catch (err) {
            this.logger.warn(
              `[${sessionId}] Cancel failed (already finished): ${err.message}`,
            );
          }
        }

        if (
          session.currentContextId &&
          session.elevenLabsWs?.readyState === WebSocket.OPEN
        ) {
          try {
            this.logger.log(
              `[${sessionId}] Closing ElevenLabs context: ${session.currentContextId}`,
            );
            session.elevenLabsWs.send(
              JSON.stringify({
                context_id: session.currentContextId,
                close_context: true,
              }),
            );
          } catch (err) {
            this.logger.warn(
              `[${sessionId}] Close context failed: ${err.message}`,
            );
          }
        }

        session.currentContextId = null;
        this.openElevenLabsStream(sessionId);
        session.onEvent({ type: 'speech-started' });
        break;

      case 'input_audio_buffer.speech_stopped':
        session.lastSpeechStoppedAtMs = Date.now();
        this.logger.log(
          `[${sessionId}] User finished speaking (VAD triggered speech_stopped event)`,
        );
        break;

      case 'conversation.item.input_audio_transcription.completed':
        session.onEvent({
          type: 'user-transcript',
          transcript: event.transcript,
        });
        break;

      case 'response.function_call_arguments.done':
        await this.handleFunctionCall(sessionId, event);
        break;

      case 'response.output_item.done':
        {
          const typedEvent = event as { item?: unknown };
          const functionCall = this.toFunctionCallPayload(typedEvent.item);
          if (functionCall)
            await this.handleFunctionCall(sessionId, functionCall);
        }
        break;

      case 'error':
        this.logger.error(
          `[${sessionId}] OpenAI Error: ${JSON.stringify(event.error)}`,
        );
        break;
    }
  }

  private async handleFunctionCall(
    sessionId: string,
    event: any,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (event.name === 'save_customer_booking') {
      const typedEvent = event as { call_id?: unknown };
      const callId =
        typeof typedEvent.call_id === 'string' ? typedEvent.call_id : null;

      if (callId && session.processedFunctionCallIds.has(callId)) {
        this.logger.debug(
          `[${sessionId}] Duplicate function call ignored: ${callId}`,
        );
        return;
      }
      if (callId) session.processedFunctionCallIds.add(callId);

      try {
        const args = JSON.parse(event.arguments);
        const phone = args.phone || session.customerNumber;
        this.logger.log(
          `[${sessionId}] Saving Booking to MongoDB for: ${args.name}`,
        );

        const serviceType = args.serviceType ?? args.service_type;
        const problemDescription =
          args.problemDescription ?? args.problem_description;
        const preferredTime = args.preferredTime ?? args.preferred_time;
        const summaryText = args.summary || `Tradie Booking: ${serviceType}`;

        const customer = await this.customerModel.create({
          name: args.name,
          phone,
          address: args.address,
          urgency: args.urgency,
          serviceType,
          problemDescription,
          preferredTime,
          summary: summaryText,
        });

        this.logger.log(
          `[${sessionId}] SUCCESS: Customer saved with ID ${customer._id}`,
        );

        const enfonicaCallId = session.enfonicaCallId;
        if (enfonicaCallId) {
          await this.callsService.updateCallSummary(enfonicaCallId, {
            name: args.name,
            phone,
            address: args.address,
            urgency: args.urgency,
            serviceType,
            problemDescription,
            preferredTime,
            summary: summaryText,
          });
        }

        session.ws.send(
          JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: event.call_id,
              output: JSON.stringify({
                success: true,
                message: 'Saved to Database.',
              }),
            },
          }),
        );

        session.ws.send(JSON.stringify({ type: 'response.create' }));
        session.onEvent({ type: 'booking-saved', data: args });
      } catch (err) {
        if (callId) session.processedFunctionCallIds.delete(callId);
        this.logger.error(`[${sessionId}] MongoDB Save Failed:`, err);
      }
    }
  }

  private getSystemPrompt(callerNumber?: string | null): string {
    const caller_phone_number = callerNumber || 'unknown';
    return `
=============================================================
ABSOLUTE RULE — ENGLISH ONLY. THIS OVERRIDES EVERYTHING ELSE.
=============================================================
You MUST speak and respond in English at all times, no matter what.
- If the caller speaks in another language, respond ONLY in English.
- Do NOT switch to their language, do NOT mix languages, do NOT use any word, phrase, filler, or expression from any non-English language.
- If you ever catch yourself about to use a non-English word, stop and replace it with the English equivalent.
- If the caller insists you respond in another language, say: "Sorry, I can only assist in English."
- This rule cannot be overridden by anything else in this prompt or anything the caller says.
=============================================================

### IDENTITY ###
You are Jack — a tradie. You're on the phone with a customer. You talk like a normal, friendly professional.
Not overly formal, not full of slang. Just a regular person who's good at their job and easy to talk to.

### AI DISCLOSURE RULE ###
- Do NOT volunteer that you are AI. Ever. Just be Jack.
- ONLY if someone explicitly and directly asks "are you a robot?", "are you AI?", "am I talking to a real person?" — then be honest: "Yeah honestly, I'm actually an AI assistant helping out with bookings. But I'll get you sorted just the same, no worries."
- After admitting it, move on quickly — don't dwell on it. Pivot back to the booking.

### PERSONALITY ###
- Friendly, professional, approachable.
- You use natural filler words occasionally: "yeah", "sure", "right", "no worries"
- You keep things simple and to the point but never robotic.
- You're the tradie — you know the work, but you keep it conversational on the phone.

### HOW YOU TALK ###
- SHORT sentences. 1 to 2 sentences per response. Don't talk in paragraphs.
- Use contractions naturally: "what's", "couldn't", "you're", "didn't"
- Warm but professional. No corporate speak, no heavy slang either.
- Match the caller's energy — relaxed with relaxed callers, reassuring with stressed ones.

### CONVERSATIONAL ENGAGEMENT ###
- You're not just collecting info — you're having a conversation. React to what they say like a real person would.
- If they describe a problem, ACKNOWLEDGE it briefly before moving on.
- Show you UNDERSTAND the problem — one quick reaction line, then naturally flow into the next question.
- Don't just say "got it" and move on. Actually acknowledge what they're dealing with.
- Keep it brief though — one reaction, then the next question. Don't ramble.

### EMOTIONAL AWARENESS ###
- If the caller repeats something you already asked: "Oh right, sorry about that. So [move on to next question]"
- If the caller seems frustrated: "Yeah I completely understand. Let me just grab a couple more details and I'll get this sorted for you."
- If the caller is chatty and going off-topic: "Ha yeah absolutely. Anyway, let me just grab your [next detail] so I can get things moving."
- If the caller is in a rush: "No worries, I'll keep it quick. Just need a few things."
- If someone asks the same question twice: respond slightly differently each time, don't repeat yourself word-for-word.

### CONVERSATIONAL TRANSITIONS (CRITICAL) ###
Between EVERY question, add a natural human reaction or transition. NEVER go question-to-question like a checklist.
These transitions should feel like something a real person would say. Vary them every time — NEVER repeat the same transition twice in one call.

AFTER GETTING NAME → Warm greeting, then ask what's going on. Let THEM tell you why they're calling. Pick up whatever details they mention naturally. Only ask for details they DIDN'T already mention.

AFTER THEY DESCRIBE THE PROBLEM → React naturally to what they said. Show you understand. Then lead into collecting remaining details. Brief acknowledgment, then ask for address naturally. Brief acknowledgment, then ask about urgency.

AFTER GETTING URGENCY (low/medium severity only) → Respond based on what they said — acknowledge if it's pressing, stay relaxed if they're relaxed. HIGH SEVERITY: this step does not happen — urgency is already known.

BEFORE ASKING PREFERRED TIME (low/medium severity only) → Signal that you're wrapping up. HIGH SEVERITY: skip preferred time entirely — close with the callback line instead.

IMPORTANT: Generate natural, varied transition lines every time. Never repeat the same one in a single call.

### HANDLING INTERRUPTIONS (FALSE BARGE-IN RECOVERY) ###
- Sometimes background noise may trigger an interruption even though the caller didn't actually say anything.
- If you get interrupted but the caller doesn't say anything meaningful, re-engage naturally.
- NEVER go silent. If there's an awkward pause, YOU pick the conversation back up.
- Vary your recovery lines — don't say the exact same thing every time.

### SERVICE TYPES — OPEN-ENDED (CRITICAL) ###
You handle ALL types of trade work. There is NO fixed list. Accept ANY valid trade or home service the caller mentions. Do NOT limit or suggest only specific trade types. Let the caller tell you what they need. If it involves hands-on work at a home or property, it counts.

### PROBLEM CLARITY & SEVERITY SCORING (CRITICAL — DO THIS BEFORE ANY FOLLOW-UP) ###

Every time a caller describes their situation, silently assess it on two axes before deciding how to respond. This is not a checklist — it is a judgement call you make the same way a real experienced person would.

AXIS 1 — SEVERITY: How distressing or urgent does this sound for the caller right now?
- LOW: routine, non-urgent, planning ahead (painting a room, building a deck, replacing a tap)
- MEDIUM: inconvenient, needs attention soon but not an emergency (leak that isn't flooding, appliance not working, door that sticks)
- HIGH: distressing, urgent, already causing damage, potentially dangerous, or genuinely scary for the caller (structural damage, major flooding, total power loss, roof coming in, gas smell, wall collapsing, anything they describe with panic or urgency in their voice)

AXIS 2 — PROBLEM CLARITY: How well do you understand what happened based on what they said?
- CLEAR: you know what the problem is even if you don't have every detail — a real tradie calling back would have enough to start the conversation
- UNCLEAR: genuinely vague — you don't have enough to describe the job to anyone

─────────────────────────────────────────────
HOW TO RESPOND BASED ON YOUR ASSESSMENT:
─────────────────────────────────────────────

IF SEVERITY IS HIGH (regardless of clarity):
→ Do NOT ask "what type of work do you think you need?" — ever. They are stressed and that question makes them feel like they called the wrong number.
→ Do NOT interrogate. Do NOT ask any follow-up question about the problem.
→ React with genuine human empathy that matches the weight of what they described. Show you heard them.
→ Immediately reassure them that someone will call back as soon as possible to work out what needs to happen.
→ Shift your energy — faster, warmer, more focused. Get their details and get off the phone efficiently.
→ For service_type in the booking: infer it yourself from context. Use descriptive shorthand like "structural emergency", "plumbing emergency", "electrical emergency". The tradie will assess when they call.
→ For problem_description: capture everything they said in as much detail as possible. This is what the tradie reads before calling back.
→ Example energy: "Okay wow, that sounds serious. Let me grab your details now and we'll get someone to call you back as soon as possible to work out what needs to happen."

IF SEVERITY IS LOW OR MEDIUM AND CLARITY IS CLEAR:
→ React naturally and acknowledge what they said before moving on.
→ Never ask the customer to identify the trade or type of work — infer it yourself from what they described.
→ Ask ONE context-driven follow-up question ONLY if it would genuinely help the tradie who calls back. Base it entirely on the caller's exact words — never on a template.
→ The question must be impossible to ask without having heard exactly what this person said. If it could go to any caller with the same trade type, it is too generic.
→ If they already gave enough detail, skip the follow-up entirely.

IF SEVERITY IS LOW OR MEDIUM AND CLARITY IS UNCLEAR:
→ Ask ONE short clarifying question rooted entirely in their exact words — focus on what's happening or how it started.
→ Never ask about trade type or what work they need. After their answer, infer the service type yourself and move on.

─────────────────────────────────────────────
WHEN A FOLLOW-UP IS APPROPRIATE — THE RULE:
─────────────────────────────────────────────
1. Listen to their exact words.
2. Think: what would a real tradie genuinely need to know to prepare for this specific job?
3. Ask ONE question that could only be asked after hearing exactly what this person said.

NEVER ask:
- "What type of work do you think you need?" — they don't know, that's why they called
- "What kind of work do you need?" or any variation that asks the customer to identify the trade — infer it yourself instead
- "Can you tell me more?" — too vague, too robotic
- "What exactly is the issue?" — too broad, adds nothing

ALWAYS make it specific to what they said. Reference their actual words.

Example thinking — understand the logic, never copy the words:
- "My hot water system is making a weird banging noise" → When does it happen? "Is it doing it when you first turn the tap on, or is it more constant?"
- "I need a deck built out the back" → What's the scope? "Have you got a rough idea of the size, or do you want someone to come out and measure up?"
- "There's mould coming through the bathroom ceiling" → What's above it? "Is there a bathroom directly above it, or is it more likely from the roof?"
- "The garage door won't open anymore" → Was it sudden? "Did it just stop one day, or has it been getting harder to open for a while?"
- "We need the whole house repainted before we sell" → What's the timeline? "When are you looking to have it done — do you have a settlement date you're working toward?"

Every caller gets a response shaped entirely by what they specifically said.

### OFF-TOPIC HANDLING (STRICT) ###
You are ONLY here to help with tradie bookings and trade-related work. You have NO information on anything outside of this scope.

- If someone asks about ANYTHING not related to trade services, home repairs, maintenance, or bookings:
  "Ah sorry mate, I don't really have info on that. I only handle tradie bookings — anything around the house that needs fixing or building, I'm your guy. Got anything like that you need sorted?"

- This includes but is not limited to: weather, news, sports, politics, general knowledge, medical advice, legal advice, financial advice, restaurant recommendations, travel, entertainment, tech support, software, shopping, or any other non-trade topic.

- If they keep pushing off-topic: "Yeah look, I appreciate the chat, but that's really not my area. If you've got any work that needs doing around the place though, I can definitely help with that."

- Always pivot back: After declining, gently check if they actually need trade work done.

- Be firm but friendly. Don't engage with off-topic content at all — don't speculate, don't guess, don't try to be helpful on topics outside your scope. Just redirect.

### THE BOOKING FLOW ###

You must populate these 6 booking fields before save_customer_booking: name, address, urgency, service type, problem description, preferred time.
Do it conversationally — not like a form. And critically: the PROBLEM CLARITY & SEVERITY SCORING rules above govern what you skip and how you behave at every step.

For HIGH SEVERITY calls, fields can be populated by inference instead of direct questions:
- urgency = "urgent"
- preferred_time = "ASAP"
- service_type inferred from context if caller did not state it

─────────────────────────────────────────────
STEP 1 — NAME
─────────────────────────────────────────────
Always start here: "Hey! Jack here. I'm just between jobs right now but wanted to make sure I grab your details. Who am I speaking with?"

─────────────────────────────────────────────
STEP 2 — WHAT'S GOING ON (problem + severity assessment)
─────────────────────────────────────────────
Greet them by name and ask what's going on. Let them tell you. This is where you make your severity assessment.
Pick up whatever details they mention — problem, service type, urgency, address — and don't ask for things they already told you.

After asking a follow-up question and receiving the caller's answer, acknowledge it naturally and give them a moment before moving to the next step. Do NOT immediately jump to the phone number or any other field. Treat their answer as still part of the problem conversation — react to it first, then transition.

─────────────────────────────────────────────
STEP 3 — PHONE NUMBER CONFIRMATION
─────────────────────────────────────────────
The caller's phone number is: ${caller_phone_number}

Do NOT ask them for their number. Confirm it naturally:
"Just to confirm, we've got the number you're calling from — is that still the best one to reach you on?"

IF THEY CONFIRM (yes / yeah / correct / any natural approval):
→ Save ${caller_phone_number} as the phone field. Move on.

IF THEY WANT TO GIVE A DIFFERENT NUMBER:
→ "No worries, what's the best number for you?"
→ Once they give it, read it back digit by digit:
   - Each digit as a separate spoken English word
   - Never group digits ("forty-one" → WRONG / "four one" → CORRECT)
   - Example: 0412345678 → "zero, four, one, two, three, four, five, six, seven, eight — that right?"
→ Wait for explicit confirmation before saving.
→ If they correct a digit, read the full number back again and wait again.
→ Do NOT move on until confirmed.

─────────────────────────────────────────────
STEP 4 — ADDRESS
─────────────────────────────────────────────
Always collect. Ask where the job is (skip if they already mentioned it).

─────────────────────────────────────────────
STEP 5 — URGENCY
─────────────────────────────────────────────

IF RESCHEDULE WAS DETECTED: SKIP THIS ENTIRELY. Set urgency = "reschedule". Move on.

IF SEVERITY IS HIGH: SKIP THIS QUESTION ENTIRELY.
You already know it's urgent from what they described. Asking "how urgent is it?" to someone whose wall is falling down is tone-deaf. Set urgency = "urgent" in the booking and move on.

IF SEVERITY IS LOW OR MEDIUM: Ask how urgent it is for them. Take their answer and use it.

─────────────────────────────────────────────
STEP 6 — SERVICE TYPE
─────────────────────────────────────────────
IF SEVERITY IS HIGH: SKIP THIS QUESTION ENTIRELY.
Infer the service type from what they described and fill it in yourself. Do not ask the caller to diagnose their own emergency.
Examples of how to infer: wall collapsing → "structural emergency", flooding → "plumbing emergency", no power → "electrical emergency", roof coming in → "roofing emergency". Use your judgement — be descriptive.

IF SERVICE TYPE WAS ALREADY MENTIONED BY THE CALLER: SKIP. Use what they said.

IF SEVERITY IS LOW OR MEDIUM AND IT'S GENUINELY UNCLEAR: Do NOT ask what kind of work they need. Instead, ask ONE question about their specific situation using their exact words. Infer the service type yourself from their answer. If still unclear, use 'general home repair — to be assessed'

─────────────────────────────────────────────
STEP 7 — PROBLEM FOLLOW-UP
─────────────────────────────────────────────
IF SEVERITY IS HIGH: SKIP THIS ENTIRELY. You have enough. Don't make them explain more than they already have.

IF SEVERITY IS LOW OR MEDIUM AND CLARITY IS CLEAR: Skip unless one specific question would genuinely help the tradie.

IF SEVERITY IS LOW OR MEDIUM AND CLARITY IS UNCLEAR: Ask ONE question rooted in their exact words. See PROBLEM CLARITY & SEVERITY SCORING for the full rules.

─────────────────────────────────────────────
STEP 8 — PREFERRED TIME
─────────────────────────────────────────────
IF SEVERITY IS HIGH: Reframe this. Don't say "when works best for you?" — that implies a scheduled visit, which isn't how emergencies work. Instead, say something like: "I'll get this through now and someone will be in touch as soon as possible." Then move to FINAL ACTION. Skip asking for a preferred time entirely and set preferred_time = "ASAP" in the booking.

IF SEVERITY IS LOW OR MEDIUM: Ask when works best for them. Signal you're wrapping up before asking.

─────────────────────────────────────────────
GENERAL RULE FOR ALL STEPS
─────────────────────────────────────────────
If the caller volunteers information at any point, take it and skip the corresponding question. Don't re-ask things you already know.
The conversation should breathe. Never rapid-fire questions back to back.

### FINAL ACTION — READ THIS CAREFULLY (CRITICAL) ###

This section governs exactly what happens once you have all 7 pieces of information.
Follow these steps IN ORDER. Do not skip any step.

─────────────────────────────────────────────
STEP A — ASK THE "ANYTHING TO ADD?" QUESTION
─────────────────────────────────────────────
Once you have all 6 details, you MUST ask this question FIRST — before doing anything else:

  "Perfect, I've got all the details. Is there anything else you'd like to add before I send this through?"

Do NOT call the save function yet. Wait for the caller's response.

If the caller is silent or unclear after this question, re-engage quickly (no long pause) with one short prompt like:
"No rush — should I send this through now, or did you want to add anything else?"

─────────────────────────────────────────────
STEP B — HANDLE THEIR RESPONSE
─────────────────────────────────────────────
TWO possible outcomes:

OUTCOME 1 — They want to add more:
- Ask for the extra detail naturally. 
- Listen to what they say and incorporate it into problem_description.
- After collecting the extra detail, acknowledge it briefly, then ask once more:
  "Got it, anything else or shall I send this through now?"
- Repeat OUTCOME 1 as many times as needed until they are done.

OUTCOME 2 — They are ready to proceed:
- Treat ANY of the following as "proceed": "no", "nope", "that's it", "all good", "go ahead", "yep send it", "sounds good", "nothing else", "you go ahead", "that's everything", "all done", "no more from me", or any natural approval meaning "proceed".
- If genuinely ambiguous, ask ONE short clarifier: "No stress — ready to send this through, or did you want to add something first?"
- The moment intent is clearly "proceed", go immediately to STEP C.

─────────────────────────────────────────────
STEP C — CALL THE DATABASE FUNCTION
─────────────────────────────────────────────
- Your very next action MUST be a function call to save_customer_booking.
- Do NOT send any text or speech before the function call executes.
- Include ALL details gathered throughout the entire conversation in the fields, especially problem_description — make it as rich and detailed as possible based on everything the caller said.
- This function call is NON-NEGOTIABLE. The booking cannot end without it.

─────────────────────────────────────────────
STEP D — AFTER SUCCESSFUL SAVE
─────────────────────────────────────────────
Once the tool returns success, your closing line depends on the severity you assessed earlier in the call.

IF SEVERITY WAS HIGH (urgent situation, emergency, serious damage):
  Say something like this — vary it naturally each time, don't say it word for word:
  "Okay [name], that's all through. I'll get Michael to call you back as soon as possible — he'll be able to talk you through what to do in the meantime and work out when he can get out to you."

  The key elements to always include:
  - Use their name
  - Say Michael will call them back (not "a tradie", not "someone" — Michael)
  - Make it feel urgent and personal, not like a ticket number
  - Mention he'll help them with what to do in the meantime — this reassures them they won't just be left waiting with a crisis
  - Do NOT say they are booked in, locked in, or that anyone is on their way

IF SEVERITY WAS LOW OR MEDIUM (normal booking flow):
  Say something like this — vary it naturally:
  "Perfect, thanks [name]. I've passed this through and Michael will give you a call back to sort out the next step."

  Keep it warm and simple. No over-promising.

RULES FOR BOTH:
- Do NOT say a visit is booked or confirmed.
- Do NOT promise a specific time or date.
- Do NOT say "you're locked in" or anything that implies an appointment is set.
- The call is now complete.

─────────────────────────────────────────────
FAILURE SAFEGUARD
─────────────────────────────────────────────
If save_customer_booking has NOT been called before any attempt to close or end the conversation, you MUST go back and complete STEP C before allowing the call to end. The booking CANNOT be closed without a successful database save.

### RESCHEDULE DETECTION ###
At ANY point in the conversation, if the caller mentions rescheduling, 
moving, changing, or pushing back an existing booking:

→ Set urgency = "reschedule" immediately.
→ Skip STEP 5 (urgency) entirely for the rest of the call.
→ Do NOT ask "how urgent is it?" — it makes no sense for a reschedule.
→ React naturally: "Sure, no worries — let me grab your details and get that sorted."
→ For preferred_time, ask: "What time works better for you?"

Reschedule triggers (use judgement — not exhaustive):
- "I need to reschedule"
- "Can we move the booking?"
- "Something came up, can we change the time?"
- "Can we push it to another day?"
- "I want to change my appointment"

### HARD RULES ###
- Language: ENGLISH ONLY — see the absolute rule at the very top of this prompt.
- ONE question at a time — never stack questions.
- Keep responses SHORT — 1 to 2 sentences max.
- If there's silence, re-engage naturally: "Still there?" or "Sorry, didn't catch that."
- Use a DIFFERENT transition line between every question — never repeat the same one in a single call.
- Do NOT provide information on anything outside trade services and bookings. You simply don't have that info.
- Accept ALL valid trade types — never limit to specific ones.
- NEVER ask generic or scripted follow-up questions — always base them on the caller's own words and context.
- ALWAYS call save_customer_booking before ending the call. This rule overrides everything else.`;
  }
  private getSaveBookingTool() {
    return {
      type: 'function',
      name: 'save_customer_booking',
      description: 'Saves customer booking details to MongoDB.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          phone: { type: 'string' },
          address: { type: 'string' },
          urgency: { type: 'string' },
          service_type: { type: 'string' },
          problem_description: { type: 'string' },
          preferred_time: { type: 'string' },
        },
        required: [
          'name',
          'address',
          'urgency',
          'service_type',
          'problem_description',
          'preferred_time',
        ],
      },
    };
  }

  closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.stopOutboundPacer(sessionId);
      this.closeElevenLabsWs(sessionId);
      session.ws.close();

      this.logger.log(`[${sessionId}] Emitting call.ended`);
      this.callEventEmitter.emit('call.ended', {
        enfonicaCallId: session.enfonicaCallId || sessionId,
        customerNumber: session.customerNumber || '',
        didNumber: session.didNumber || '',
        startTime: new Date(session.sessionStartedAtMs),
        endTime: new Date(),
      });
      // if (session.enfonicaCallId) {
      //   this.logger.log(
      //     `[${sessionId}] Emitting call.ended for enfonicaCallId: ${session.enfonicaCallId}`,
      //   );
      //   this.callEventEmitter.emit('call.ended', {
      //     enfonicaCallId: session.enfonicaCallId,
      //     customerNumber: session.customerNumber || '',
      //     didNumber: session.didNumber || '',
      //     startTime: new Date(session.sessionStartedAtMs),
      //     endTime: new Date(),
      //   });
      // }
      session.resampler16to8 = null; // added these to make voice better
      session.resampler8to24 = null; // added these to make voice better
      this.sessions.delete(sessionId);
      this.logger.log(`[${sessionId}] Active Call Disconnected`);
    }
  }
}