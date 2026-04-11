import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import WebSocket from 'ws';
import { Customer, CustomerDocument } from './Schema/customer.schema';

/**
 * RealtimeSession interface tracks the state of a single voice call.
 * This includes the connection to OpenAI (Brain) and ElevenLabs (Voice).
 */
interface RealtimeSession {
  ws: WebSocket;                 // Connection to OpenAI Realtime API
  elevenLabsWs: WebSocket | null; // Connection to ElevenLabs TTS API
  elevenLabsReady: boolean;       // Becomes true when ElevenLabs is ready to talk
  textBuffer: string[];          // Holds text while ElevenLabs is still connecting
  isResponseActive: boolean;     // Tracks if OpenAI is currently generating a response
  onEvent: (event: any) => void; // Function to send data back to the browser
}

@Injectable()
export class VoiceService {
  private readonly logger = new Logger(VoiceService.name);
  
  // This map keeps track of all active calls using the sessionId (Socket ID)
  private sessions = new Map<string, RealtimeSession>();

  constructor(
    private readonly config: ConfigService,
    @InjectModel(Customer.name)
    private readonly customerModel: Model<CustomerDocument>,
  ) {}

  /**
   * STEP 1: Create the Brain (OpenAI Session)
   * This opens a bi-directional pipe to OpenAI's GPT-4o-mini-realtime.
   */
  async createRealtimeSession(
    sessionId: string,
    onEvent: (event: any) => void,
  ): Promise<void> {
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    const model = 'gpt-4o-mini-realtime-preview';
    const url = `wss://api.openai.com/v1/realtime?model=${model}`;

    return new Promise((resolve, reject) => {
      // Create the WebSocket to OpenAI
      const ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      });

      ws.on('open', () => {
        this.logger.log(`[${sessionId}] OpenAI Realtime WebSocket connected`);

        // CONFIGURE THE BRAIN:
        // Output text only — ElevenLabs handles all voice synthesis.
        const sessionUpdate = {
          type: 'session.update',
          session: {
            modalities: ['text'],
            instructions: this.getSystemPrompt(),
            input_audio_format: 'pcm16',
            turn_detection: {
              type: 'server_vad',
              threshold: 0.8,
              prefix_padding_ms: 300,
              silence_duration_ms: 2000,
            },
            tools: [this.getSaveBookingTool()],
            tool_choice: 'auto',
          },
        };

        ws.send(JSON.stringify(sessionUpdate));

        // Initializing the session state in our Map
        this.sessions.set(sessionId, {
          ws,
          elevenLabsWs: null,
          elevenLabsReady: false,
          textBuffer: [],
          isResponseActive: false,
          onEvent,
        });

        // IMPORTANT: Pre-open ElevenLabs so it's ready before the AI starts its first word
        this.openElevenLabsStream(sessionId);
        
        resolve();
      });

      // Handle raw messages from OpenAI
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
        this.logger.log(`[${sessionId}] OpenAI WebSocket closed: ${code} - ${reason}`);
        this.closeElevenLabsWs(sessionId);
        this.sessions.delete(sessionId);
        onEvent({ type: 'session-closed' });
      });
    });
  }

  /**
   * STEP 2: Relay User Audio to OpenAI
   */
  sendAudio(sessionId: string, base64Audio: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.ws.send(JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: base64Audio,
    }));
  }

  /**
   * STEP 3: The Greeting Logic
   */
  triggerGreeting(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    setTimeout(() => {
      const s = this.sessions.get(sessionId);
      if (!s) return;
      s.ws.send(JSON.stringify({ type: 'response.create' }));
    }, 3000);
  }

  /**
   * STEP 4: The Voice (ElevenLabs Integration)
   * 
   * KEY BEHAVIOR: ElevenLabs stream-input WebSocket is single-use.
   * Once you flush (send empty text), ElevenLabs finishes and closes.
   * So each AI response needs its own connection.
   * 
   * Reuse logic: only reuse if a connection is alive AND hasn't been flushed.
   * force=true: always open fresh (used after barge-in pre-warm).
   */
  private openElevenLabsStream(sessionId: string, force = false): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Reuse existing connection if it's healthy (unless forced)
    if (
      !force &&
      session.elevenLabsWs &&
      (session.elevenLabsWs.readyState === WebSocket.OPEN ||
       session.elevenLabsWs.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    // Clean up any old/dead stream without triggering race conditions
    this.closeElevenLabsWs(sessionId);

    const apiKey = this.config.get<string>('ELEVENLABS_API_KEY');
    const voiceId = this.config.get<string>('ELEVENLABS_VOICE_ID');
    const wsUrl = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=eleven_flash_v2_5&output_format=pcm_16000`;

    const elWs = new WebSocket(wsUrl);

    elWs.on('open', () => {
      this.logger.log(`[${sessionId}] ElevenLabs WebSocket connected`);
      
      elWs.send(JSON.stringify({
        text: ' ',
        voice_settings: { 
          stability: 0.4, 
          similarity_boost: 0.75,
          speed: 1.15
        },
        xi_api_key: apiKey,
      }));

      // Only set ready if THIS connection is still the active one
      // (prevents race condition if a newer connection replaced us)
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
          session.onEvent({ type: 'audio-delta', delta: msg.audio });
        }
      } catch (err) {}
    });

    elWs.on('error', (err) => {
      this.logger.warn(`[${sessionId}] ElevenLabs WS error: ${err.message}`);
    });

    // FIX: Only update state if THIS WebSocket is still the current one.
    // Without this guard, an old connection's close event fires AFTER a new
    // connection has already opened, setting elevenLabsReady=false incorrectly.
    // This was the root cause of "no voice after first response".
    elWs.on('close', () => {
      if (session.elevenLabsWs === elWs) {
        session.elevenLabsReady = false;
      }
    });

    session.elevenLabsWs = elWs;
  }

  /**
   * Sends a text chunk to ElevenLabs for voice generation.
   */
  private sendTextToElevenLabs(sessionId: string, text: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.elevenLabsWs?.readyState === WebSocket.OPEN) {
      session.elevenLabsWs.send(JSON.stringify({ text, try_trigger_generation: true }));
    }
  }

  /**
   * Signals ElevenLabs that the sentence is finished.
   * NOTE: This causes ElevenLabs to close the connection after final audio.
   */
  private flushElevenLabsStream(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.elevenLabsWs?.readyState === WebSocket.OPEN) {
      session.elevenLabsWs.send(JSON.stringify({ text: '' }));
    }
  }

  /**
   * Kills the voice stream (used during barge-in/interruptions).
   */
  private closeElevenLabsWs(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.elevenLabsWs) {
      try {
        if (session.elevenLabsWs.readyState === WebSocket.CONNECTING) {
          session.elevenLabsWs.terminate();
        } else if (session.elevenLabsWs.readyState === WebSocket.OPEN) {
          session.elevenLabsWs.close();
        }
      } catch (err) {
        this.logger.warn(`[${sessionId}] Error closing ElevenLabs WS: ${err.message}`);
      }
      session.elevenLabsWs = null;
      session.elevenLabsReady = false;
      session.textBuffer = [];
    }
  }

  /**
   * STEP 5: THE EVENT HUB
   */
  private async handleRealtimeEvent(sessionId: string, event: any): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.logger.debug(`[${sessionId}] OpenAI Debug Event: ${event.type}`);

    switch (event.type) {
      case 'response.created':
        session.isResponseActive = true;
        // Each AI response needs a fresh ElevenLabs connection because
        // flush (empty text) closes the previous one.
        // If a pre-warmed connection from barge-in is alive, this reuses it.
        // If not (e.g. first greeting, or flush killed the old one), opens new.
        this.openElevenLabsStream(sessionId);
        break;

      case 'response.done':
        session.isResponseActive = false;
        break;

      case 'response.text.delta':
        if (session.elevenLabsReady) {
          this.sendTextToElevenLabs(sessionId, event.delta);
        } else {
          session.textBuffer.push(event.delta);
        }
        session.onEvent({ type: 'transcript-delta', delta: event.delta });
        break;

      case 'response.text.done':
        this.flushElevenLabsStream(sessionId);
        session.onEvent({ type: 'transcript-done', transcript: event.text });
        break;

      case 'input_audio_buffer.speech_started':
        this.logger.log(`[${sessionId}] USER INTERRUPTED -> Stopping AI Voice`);

        // Only cancel if OpenAI is actively generating
        if (session.isResponseActive) {
          session.ws.send(JSON.stringify({ type: 'response.cancel' }));
        }

        // Kill current ElevenLabs audio immediately
        this.closeElevenLabsWs(sessionId);

        // PRE-WARM: Start the TLS handshake NOW while user is still speaking.
        // By the time OpenAI generates its next response, ElevenLabs is ready.
        this.openElevenLabsStream(sessionId, true);

        session.onEvent({ type: 'speech-started' });
        break;

      case 'conversation.item.input_audio_transcription.completed':
        session.onEvent({ type: 'user-transcript', transcript: event.transcript });
        break;

      case 'response.function_call_arguments.done':
        await this.handleFunctionCall(sessionId, event);
        break;

      case 'error':
        this.logger.error(`[${sessionId}] OpenAI Error: ${JSON.stringify(event.error)}`);
        break;
    }
  }

  /**
   * STEP 6: DATA PERSISTENCE (Saving to MongoDB)
   */
  private async handleFunctionCall(sessionId: string, event: any): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (event.name === 'save_customer_booking') {
      try {
        const args = JSON.parse(event.arguments);
        this.logger.log(`[${sessionId}] Saving Booking to MongoDB for: ${args.name}`);

        const customer = await this.customerModel.create({
          name: args.name,
          phone: args.phone,
          address: args.address,
          urgency: args.urgency,
          serviceType: args.service_type,
          problemDescription: args.problem_description,
          preferredTime: args.preferred_time,
          summary: `Tradie Booking: ${args.service_type}`,
        });

        this.logger.log(`[${sessionId}] SUCCESS: Customer saved with ID ${customer._id}`);

        session.ws.send(JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: event.call_id,
            output: JSON.stringify({ success: true, message: 'Saved to Database.' }),
          },
        }));

        session.ws.send(JSON.stringify({ type: 'response.create' }));
        session.onEvent({ type: 'booking-saved', data: args });

      } catch (err) {
        this.logger.error(`[${sessionId}] MongoDB Save Failed:`, err);
      }
    }
  }

  /**
   * THE AI SCRIPT (System Prompt)
   */
  private getSystemPrompt(): string {
    return `### IDENTITY ###
You are a professional virtual voice assistant for a tradesperson (tradie). 
Your ONLY goal is to collect 7 specific pieces of information from the caller. 

### THE 7-QUESTION SEQUENCE ###
You MUST ask these questions exactly in this order. NEVER skip a step. 
1. GREETING & NAME: "Hey! The tradie is currently busy, and I am his virtual assistant. could you please tell me your name?"
2. PHONE: "Thanks [name]. What is the best phone number to reach you on?"
3. ADDRESS: "And what is the address where you need the service?"
4. URGENCY: "How urgent is this job? Is it an emergency, or can it wait a few days?"
5. SERVICE TYPE: "What kind of work do you need help with? For example, plumbing or electrical?"
6. PROBLEM: "Could you give me a quick description of the problem?"
7. VISIT TIME: "Finally, what day and time would you prefer for the visit?"

### REDIRECT AND PIVOT (CRITICAL) ###
- If the user says something unrelated or off-topic, acknowledge them briefly ("I understand", "Got it") and then IMMEDIATELY pivot back to the next missing piece of information.
- Example: "I can definitely help with that once we finish this booking. So, what is your address?"
- NEVER ask extra questions. NEVER give commentary outside the sequence.

### HANDLING INTERRUPTIONS (FALSE BARGE-IN RECOVERY) ###
- Sometimes background noise (a door closing, a cough, traffic) may sound like the user is speaking, causing you to stop mid-sentence.
- If you are interrupted but the user does NOT say anything meaningful (silence or just noise), you MUST re-engage by saying something like:
  "Sorry, I didn't quite catch that. So, [repeat the last question you were asking]."
- NEVER stay silent. If there is an awkward pause after an interruption, always take the initiative and continue the conversation.
- This is CRITICAL for maintaining a professional experience.

### FINAL ACTION (MANDATORY - HIGHEST PRIORITY) ###
- The MOMENT you have all 7 pieces of information (name, phone, address, urgency, service type, problem description, preferred time), you MUST IMMEDIATELY call the save_customer_booking tool.
- Do NOT say anything before calling the tool. Do NOT ask for confirmation. Do NOT summarize. Just CALL THE TOOL.
- Even if the conversation was messy or had interruptions, if you have all 7 data points, CALL THE TOOL NOW.
- After the tool returns success, say EXACTLY: "Thank you so much! I have all your details now. I am saving this for the tradie, and they will call you back shortly. Have a great day!"
- Do not say the final message until the tool has been called.

### RULES ###
- Language: English ONLY.
- Tone: Professional, concise, and PERSISTENT.
- Responses: ONE question at a time.
- Silence Duration: If the user stops speaking for 2 seconds, assume they are done and respond.`;
  }

  /**
   * TOOL DEFINITION
   */
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
        required: ['name', 'phone', 'address', 'urgency', 'service_type', 'problem_description', 'preferred_time'],
      },
    };
  }

  /**
   * Final cleanup of a session.
   */
  closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.closeElevenLabsWs(sessionId);
      session.ws.close();
      this.sessions.delete(sessionId);
      this.logger.log(`[${sessionId}] Active Call Disconnected`);
    }
  }
}