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
  ws: WebSocket; // Connection to OpenAI Realtime API
  elevenLabsWs: WebSocket | null; // Connection to ElevenLabs TTS API
  elevenLabsReady: boolean; // Becomes true when ElevenLabs is ready to talk
  textBuffer: string[]; // Holds text while ElevenLabs is still connecting
  isResponseActive: boolean; // Tracks if OpenAI is currently generating a response
  onEvent: (event: any) => void; // Function to send data back to the browser
  sessionStartedAtMs: number;
  openAiConnectedAtMs: number | null;
  elevenLabsConnectedAtMs: number | null;
  greetingTriggeredAtMs: number | null;
  firstResponseCreatedAtMs: number | null;
  firstAudioDeltaLogged: boolean;
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
   */
  async createRealtimeSession(
    sessionId: string,
    onEvent: (event: any) => void,
  ): Promise<void> {
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    const model = 'gpt-4o-mini-realtime-preview';
    const url = `wss://api.openai.com/v1/realtime?model=${model}`;
    const sessionStartedAtMs = Date.now();

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      });

      ws.on('open', () => {
        const openAiConnectedAtMs = Date.now();
        this.logger.log(`[${sessionId}] OpenAI Realtime WebSocket connected`);
        this.logger.log(
          `[${sessionId}] Timing: OpenAI WS connected in ${openAiConnectedAtMs - sessionStartedAtMs}ms`,
        );

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

    session.ws.send(
      JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: base64Audio,
      }),
    );
  }

  /**
   * STEP 3: The Greeting Logic
   */
  triggerGreeting(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.greetingTriggeredAtMs = Date.now();
    this.logger.log(
      `[${sessionId}] Timing: greeting trigger fired at ${session.greetingTriggeredAtMs - session.sessionStartedAtMs}ms from session start`,
    );
    session.ws.send(JSON.stringify({ type: 'response.create' }));
  }

  /**
   * STEP 4: The Voice (ElevenLabs Integration)
   */
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
    const wsUrl = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=eleven_flash_v2_5&output_format=pcm_16000`;

    const elWs = new WebSocket(wsUrl);

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
            speed: 1.15,
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
              `[${sessionId}] Timing: first audio delta at ${firstAudioAtMs - session.sessionStartedAtMs}ms (openai=${openAiMs}ms, elevenlabs=${elevenLabsMs}ms, greeting=${greetingMs}ms, response_created_after_greeting=${responseCreatedAfterGreetingMs}ms, audio_after_response_created=${firstAudioAfterResponseCreatedMs}ms)`,
            );
          }
          session.onEvent({ type: 'audio-delta', delta: msg.audio });
        }
      } catch (err) {}
    });

    elWs.on('error', (err) => {
      this.logger.warn(`[${sessionId}] ElevenLabs WS error: ${err.message}`);
    });

    elWs.on('close', () => {
      if (session.elevenLabsWs === elWs) {
        session.elevenLabsReady = false;
      }
    });

    session.elevenLabsWs = elWs;
  }

  private sendTextToElevenLabs(sessionId: string, text: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.elevenLabsWs?.readyState === WebSocket.OPEN) {
      session.elevenLabsWs.send(
        JSON.stringify({ text, try_trigger_generation: true }),
      );
    }
  }

  private flushElevenLabsStream(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.elevenLabsWs?.readyState === WebSocket.OPEN) {
      session.elevenLabsWs.send(JSON.stringify({ text: '' }));
    }
  }

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
        this.logger.warn(
          `[${sessionId}] Error closing ElevenLabs WS: ${err.message}`,
        );
      }
      session.elevenLabsWs = null;
      session.elevenLabsReady = false;
      session.textBuffer = [];
    }
  }

  /**
   * STEP 5: THE EVENT HUB
   */
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

        if (session.isResponseActive) {
          try {
            session.ws.send(JSON.stringify({ type: 'response.cancel' }));
          } catch (err) {
            this.logger.warn(
              `[${sessionId}] Cancel failed (already finished): ${err.message}`,
            );
          }
        }

        this.closeElevenLabsWs(sessionId);
        this.openElevenLabsStream(sessionId, true);
        session.onEvent({ type: 'speech-started' });
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

      case 'error':
        this.logger.error(
          `[${sessionId}] OpenAI Error: ${JSON.stringify(event.error)}`,
        );
        break;
    }
  }

  /**
   * STEP 6: DATA PERSISTENCE (Saving to MongoDB)
   */
  private async handleFunctionCall(
    sessionId: string,
    event: any,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (event.name === 'save_customer_booking') {
      try {
        const args = JSON.parse(event.arguments);
        this.logger.log(
          `[${sessionId}] Saving Booking to MongoDB for: ${args.name}`,
        );

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

        this.logger.log(
          `[${sessionId}] SUCCESS: Customer saved with ID ${customer._id}`,
        );

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
        this.logger.error(`[${sessionId}] MongoDB Save Failed:`, err);
      }
    }
  }

  /**
   * THE AI SCRIPT (System Prompt)
   */
  private getSystemPrompt(): string {
    return `### IDENTITY ###
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

AFTER THEY DESCRIBE THE PROBLEM → React naturally to what they said. Show you understand. Then lead into collecting remaining details.

AFTER GETTING PHONE NUMBER → Brief acknowledgment, then ask for address naturally.

AFTER GETTING ADDRESS → Brief acknowledgment, then ask about urgency.

AFTER GETTING URGENCY → Respond differently based on urgency level — acknowledge if it's serious, reassure if it's relaxed.

BEFORE ASKING PREFERRED TIME (last question) → Signal that you're wrapping up.

IMPORTANT: Generate natural, varied transition lines every time. Never repeat the same one in a single call.

### HANDLING INTERRUPTIONS (FALSE BARGE-IN RECOVERY) ###
- Sometimes background noise may trigger an interruption even though the caller didn't actually say anything.
- If you get interrupted but the caller doesn't say anything meaningful, re-engage naturally.
- NEVER go silent. If there's an awkward pause, YOU pick the conversation back up.
- Vary your recovery lines — don't say the exact same thing every time.

### SERVICE TYPES — OPEN-ENDED (CRITICAL) ###
You handle ALL types of trade work. There is NO fixed list. Accept ANY valid trade or home service the caller mentions. Do NOT limit or suggest only specific trade types. Let the caller tell you what they need. If it involves hands-on work at a home or property, it counts.

### CONTEXT-DRIVEN FOLLOW-UP QUESTIONS (CRITICAL) ###
This is what makes the conversation feel real and NOT like a script.

When a caller describes their problem or mentions a service type, you MUST ask a follow-up question that is DIRECTLY generated from the EXACT words and context the caller just used.

DO NOT use any pre-written, templated, or memorized questions. Instead:
1. LISTEN carefully to the specific words, details, and situation the caller described.
2. THINK about what a real, experienced tradie would naturally want to clarify or know more about based on EXACTLY what this caller said.
3. ASK ONE short, specific question that shows you were actually listening and that digs deeper into THEIR unique situation.

THE PRINCIPLE: Your follow-up must be impossible to ask WITHOUT having heard what the caller just said. If your question could be asked to ANY caller with the same trade type, it's too generic — make it more specific to THIS caller's words.

EXAMPLE OF THE THINKING PROCESS (do not memorize these — understand the logic):
- Caller says: "My hot water system is making a weird banging noise"
  → They said "banging noise" + "hot water system" → A real tradie would want to know WHEN the noise happens → "Is it doing it when you first turn the tap on, or is it more constant?"

- Caller says: "I need a deck built out the back"
  → They said "deck" + "out the back" → A real tradie would want to know the scope → "Have you got a rough idea of the size, or do you want me to come measure up?"

- Caller says: "There's mould coming through the bathroom ceiling"
  → They said "mould" + "bathroom ceiling" → A real tradie would want to know the source → "Is there a bathroom directly above it, or is it coming from the roof side?"

- Caller says: "The garage door won't open anymore"
  → They said "garage door" + "won't open" → A real tradie would want to know what happened → "Did it just stop one day, or has it been getting harder to open for a while?"

- Caller says: "We need the whole house repainted before we sell"
  → They said "whole house" + "repainted" + "before we sell" → A real tradie would want to know the timeline → "When are you looking to have it done by — got a settlement date or anything like that?"

These examples show the THINKING — not words to copy. Every caller gets a unique question based on their own words.

RULES:
- Only ask ONE follow-up. Don't interrogate.
- Keep it short and conversational — one sentence.
- If the caller already gave a very detailed description, SKIP the follow-up. Don't ask what you already know.
- Use their answer to build a richer problem_description when saving the booking.
- NEVER ask generic questions like "Can you tell me more?", "What exactly is the issue?", or "What type of service?" — these are lazy and scripted. Always reference something specific from what the caller said.

### OFF-TOPIC HANDLING (STRICT) ###
You are ONLY here to help with tradie bookings and trade-related work. You have NO information on anything outside of this scope.

- If someone asks about ANYTHING not related to trade services, home repairs, maintenance, or bookings:
  "Ah sorry mate, I don't really have info on that. I only handle tradie bookings — anything around the house that needs fixing or building, I'm your guy. Got anything like that you need sorted?"

- This includes but is not limited to: weather, news, sports, politics, general knowledge, medical advice, legal advice, financial advice, restaurant recommendations, travel, entertainment, tech support, software, shopping, or any other non-trade topic.

- If they keep pushing off-topic: "Yeah look, I appreciate the chat, but that's really not my area. If you've got any work that needs doing around the place though, I can definitely help with that."

- Always pivot back: After declining, gently check if they actually need trade work done.

- Be firm but friendly. Don't engage with off-topic content at all — don't speculate, don't guess, don't try to be helpful on topics outside your scope. Just redirect.

### THE BOOKING FLOW ###
You need to collect 7 things. Do it conversationally — not like a form.

1. NAME: "Hey! Jack here. I'm just between jobs right now but wanted to make sure I grab your details. Who am I speaking with?"

2. WARM TRANSITION (after getting name):
   - Greet them by name and ask what's going on. Let THEM tell you why they're calling.
   - From their response you'll likely pick up service type, problem description, maybe urgency or address.
   - Only ask for details they DIDN'T mention.

3. PHONE: Ask for their best contact number. Once they give it, READ IT BACK digit by digit — e.g. "So that's 0-4-1-2-3-4-5-6-7-8 — that right?" Wait for the caller to confirm. 
If they correct any digit, read the full corrected number back again and wait for confirmation. Do NOT move to the next question until the number is explicitly confirmed.
4. ADDRESS: Ask where the job is.
5. URGENCY: Ask how urgent it is.
6. SERVICE TYPE: (only if not already mentioned) Ask what kind of work they need — keep it open-ended, don't suggest specific trades.
7. PROBLEM: Use a context-driven follow-up question based on the caller's own words (see CONTEXT-DRIVEN FOLLOW-UP QUESTIONS above). If they already described the problem in full detail, skip this.
8. PREFERRED TIME: Ask when works best for them.

Don't force this order. If the caller volunteers info early, take it and skip those questions.
The key is: after getting the name, let the conversation BREATHE. Don't rapid-fire questions.

### FINAL ACTION (CRITICAL) ###
- Once you have ALL 7 pieces of info, IMMEDIATELY call save_customer_booking. No confirmation. No summary. Just call it.
- Include any detail from the follow-up conversation in the problem_description field — make it as detailed and useful as possible based on everything the caller said throughout the conversation.
- After the tool returns success: "Awesome, you're all locked in! I'll give you a call to sort out the rest. Thanks [name], have a good one!"

### HARD RULES ###
- Language: English only
- ONE question at a time — never stack questions
- Keep responses SHORT — 1 to 2 sentences max
- If there's silence, re-engage naturally: "Still there?" or "Sorry, didn't catch that."
- Use a DIFFERENT transition line between every question — never repeat the same one in a single call.
- Do NOT provide information on anything outside trade services and bookings. You simply don't have that info.
- Accept ALL valid trade types — never limit to specific ones.
- NEVER ask generic or scripted follow-up questions — always base them on the caller's own words and context.
- ALWAYS call save_customer_booking before ending the call. This rule overrides everything else.`;
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
        required: [
          'name',
          'phone',
          'address',
          'urgency',
          'service_type',
          'problem_description',
          'preferred_time',
        ],
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
