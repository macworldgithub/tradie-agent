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
  ws: WebSocket;                // Connection to OpenAI Realtime API
  elevenLabsWs: WebSocket | null; // Connection to ElevenLabs TTS API
  elevenLabsReady: boolean;      // Becomes true when ElevenLabs is ready to talk
  textBuffer: string[];         // Holds text while ElevenLabs is still connecting
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
        // We tell OpenAI to listen to audio, but don't output audio (we use ElevenLabs for that)
        const sessionUpdate = {
          type: 'session.update',
          session: {
            modalities: ['text', 'audio'], // Listen to user audio, respond with text
            instructions: this.getSystemPrompt(), // THE "TRADIE" SCRIPT & RULES
            voice: 'alloy', // Fallback voice (not used because we use ElevenLabs)
            input_audio_format: 'pcm16',
            output_audio_format: 'pcm16',
            turn_detection: {
              type: 'server_vad', // Automated Voice Activity Detection
              threshold: 0.8,     // 0.8 sensitivity prevents interruptions from noise
              prefix_padding_ms: 300,
              silence_duration_ms: 2000, // Wait 2 seconds of silence before AI speaks
            },
            tools: [this.getSaveBookingTool()], // Register the MongoDB tool
            tool_choice: 'auto',
          },
        };

        ws.send(JSON.stringify(sessionUpdate));

        // Initializing the session state in our Map
        this.sessions.set(sessionId, { ws, elevenLabsWs: null, elevenLabsReady: false, textBuffer: [], onEvent });

        // IMPORTANT: Pre-open ElevenLabs so it's ready before the AI starts its first word
        this.openElevenLabsStream(sessionId);
        
        // Finalize setup
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

      // Error and close handlers
      ws.on('error', (err) => {
        this.logger.error(`[${sessionId}] OpenAI WebSocket error:`, err);
        onEvent({ type: 'error', error: { message: err.message } });
        reject(err);
      });

      ws.on('close', (code, reason) => {
        this.logger.log(`[${sessionId}] OpenAI WebSocket closed: ${code} - ${reason}`);
        this.closeElevenLabsWs(sessionId); // Kill the voice too if brain closes
        this.sessions.delete(sessionId);
        onEvent({ type: 'session-closed' });
      });
    });
  }

  /**
   * STEP 2: Relay User Audio to OpenAI
   * The browser sends raw mic audio; we push it straight to OpenAI.
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
   * We wait 3 seconds to ensure all WebSockets are stable, then tell AI to "Start Speaking."
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
   * This opens a stream to ElevenLabs to convert OpenAI text into premium audio.
   */
  private openElevenLabsStream(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.closeElevenLabsWs(sessionId); // Clean up any old stream

    const apiKey = this.config.get<string>('ELEVENLABS_API_KEY');
    const voiceId = this.config.get<string>('ELEVENLABS_VOICE_ID');
    const wsUrl = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=eleven_flash_v2_5&output_format=pcm_16000`;

    const elWs = new WebSocket(wsUrl);

    elWs.on('open', () => {
      this.logger.log(`[${sessionId}] ElevenLabs WebSocket connected`);
      
      // Configuration message for ElevenLabs
      elWs.send(JSON.stringify({
        text: ' ',
        voice_settings: { 
        stability: 0.4, 
        similarity_boost: 0.75,
        speed: 1.15
       },
        xi_api_key: apiKey,
      }));

      // Flush any text that was sent to us while we were connecting
      session.elevenLabsReady = true;
      for (const text of session.textBuffer) {
        this.sendTextToElevenLabs(sessionId, text);
      }
      session.textBuffer = [];
    });

    elWs.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.audio) {
          // ELEVENLABS AUDIO CHUNK -> Forward to Browser for playback!
          session.onEvent({ type: 'audio-delta', delta: msg.audio });
        }
      } catch (err) {}
    });

    elWs.on('close', () => { session.elevenLabsReady = false; });
    session.elevenLabsWs = elWs;
  }

  /**
   * Sends a text chunk to the ElevenLabs mouth to generate voice.
   */
  private sendTextToElevenLabs(sessionId: string, text: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.elevenLabsWs?.readyState === WebSocket.OPEN) {
      session.elevenLabsWs.send(JSON.stringify({ text, try_trigger_generation: true }));
    }
  }

  /**
   * Signals ElevenLabs that the sentence is finished.
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
      session.elevenLabsWs.close();
      session.elevenLabsWs = null;
      session.elevenLabsReady = false;
      session.textBuffer = [];
    }
  }

  /**
   * STEP 5: THE EVENT HUB (Handling Brain Activities)
   * This switch case reacts to everything OpenAI does.
   */
  private async handleRealtimeEvent(sessionId: string, event: any): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Diagnostic logs (remove in production if too noisy)
    this.logger.debug(`[${sessionId}] OpenAI Debug Event: ${event.type}`);

    switch (event.type) {
      case 'response.created':
        // The AI is starting a new thought/response -> open the voice pipe!
        this.openElevenLabsStream(sessionId);
        break;

      case 'response.audio_transcript.delta':
        // OpenAI thought of a word -> send it to ElevenLabs for speaking!
        if (session.elevenLabsReady) {
          this.sendTextToElevenLabs(sessionId, event.delta);
        } else {
          session.textBuffer.push(event.delta); // Wait for connection
        }
        // Also show the word on the screen in browser
        session.onEvent({ type: 'transcript-delta', delta: event.delta });
        break;

      case 'response.audio_transcript.done':
        // OpenAI finished the sentence -> Finish speaking
        this.flushElevenLabsStream(sessionId);
        session.onEvent({ type: 'transcript-done', transcript: event.transcript });
        break;

      case 'input_audio_buffer.speech_started':
        // THE USER INTERRUPTED! Stop the AI from speaking immediately.
        this.logger.log(`[${sessionId}] USER INTERRUPTED -> Stopping AI Voice`);
        this.closeElevenLabsWs(sessionId);
        session.onEvent({ type: 'speech-started' });
        break;

      case 'conversation.item.input_audio_transcription.completed':
        // What the user said (text) -> Send to browser UI
        session.onEvent({ type: 'user-transcript', transcript: event.transcript });
        break;

      case 'response.function_call_arguments.done':
        // ALL 7 QUESTIONS ANSWERED -> Call the Database tool
        await this.handleFunctionCall(sessionId, event);
        break;

      case 'error':
        this.logger.error(`[${sessionId}] OpenAI Error: ${JSON.stringify(event.error)}`);
        break;
    }
  }

  /**
   * STEP 6: DATA PERSISTENCE (Saving to MongoDB)
   * A call to this happens automatically when the AI collects all 7 pieces of data.
   */
  private async handleFunctionCall(sessionId: string, event: any): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (event.name === 'save_customer_booking') {
      try {
        const args = JSON.parse(event.arguments);
        this.logger.log(`[${sessionId}] Saving Booking to MongoDB for: ${args.name}`);

        // Write to your database!
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

        // Tell OpenAI the database save worked!
        session.ws.send(JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: event.call_id,
            output: JSON.stringify({ success: true, message: 'Saved to Database.' }),
          },
        }));

        // Ask OpenAI to say the "Final Goodbye" message
        session.ws.send(JSON.stringify({ type: 'response.create' }));

        // Notify UI
        session.onEvent({ type: 'booking-saved', data: args });

      } catch (err) {
        this.logger.error(`[${sessionId}] MongoDB Save Failed:`, err);
      }
    }
  }

  /**
   * THE AI SCRIPT (System Prompt)
   * This is where you define the personality and the 7 questions.
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

### FINAL ACTION ###
- Once all 7 items are collected, you MUST call the save_customer_booking tool FIRST.
- After the tool returns success, say this exactly: "Thank you so much! I have all your details now. I am saving this for the tradie, and they will call you back shortly. Have a great day!"
- Do not say the final message until the tool has been called.

### RULES ###
- Language: English ONLY.
- Tone: Professional, concise, and PERSISTENT.
- Responses: ONE question at a time.
- Silence Duration: If the user stops speaking for 2 seconds, assume they are done and respond.`;
  }

  /**
   * TOOL DEFINITION
   * This is how OpenAI knows what fields to fill for the database save.
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
