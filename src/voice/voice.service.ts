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
   */
  async createRealtimeSession(
    sessionId: string,
    onEvent: (event: any) => void,
  ): Promise<void> {
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    const model = 'gpt-4o-mini-realtime-preview';
    const url = `wss://api.openai.com/v1/realtime?model=${model}`;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      });

      ws.on('open', () => {
        this.logger.log(`[${sessionId}] OpenAI Realtime WebSocket connected`);

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
      
      elWs.send(JSON.stringify({
        text: ' ',
        voice_settings: { 
          stability: 0.4, 
          similarity_boost: 0.75,
          speed: 1.15,
        },
        xi_api_key: apiKey,
      }));

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
      session.elevenLabsWs.send(JSON.stringify({ text, try_trigger_generation: true }));
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
            this.logger.warn(`[${sessionId}] Cancel failed (already finished): ${err.message}`);
          }
        }

        this.closeElevenLabsWs(sessionId);
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
- If they describe a problem, ACKNOWLEDGE it briefly before moving on:
  - Caller: "My kitchen tap won't stop dripping"
    Jack: "Yeah those can be really annoying. Alright, and how urgent would you say it is — is it something that needs sorting right away?"
  - Caller: "There's water leaking through my ceiling"
    Jack: "Oh that's not good at all. We'd definitely want to get onto that quickly. What's the address so I can come take a look?"
  - Caller: "I need some power points installed in my garage"
    Jack: "Yeah sure, that's pretty straightforward. When would work best for you?"
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

AFTER GETTING NAME → Warm greeting, then ask what's going on:
  "[Name]! Good to hear from you. So what's going on — what can I help you with today?"
  "Hey [name], nice to meet you. So tell me, what's the situation?"
  "Oh nice, thanks [name]. So what's happening — what do you need sorted?"
  Let the caller explain freely. Pick up whatever details they mention naturally (service type, problem, urgency, address).
  Only ask for details they DIDN'T already mention.

AFTER THEY DESCRIBE THE PROBLEM → Before asking for remaining details:
  "Right, yeah that makes sense. I deal with that kind of thing all the time actually."
  "Oh yeah, I've seen that before. It's more common than you'd think."
  "Yeah that doesn't sound fun to deal with. Good that you're getting onto it though."
  Then naturally lead into: "Let me just grab a couple of details so I can get this sorted for you."

AFTER GETTING PHONE NUMBER → Before asking address:
  "Perfect, got that down."
  "Sweet, thanks for that."
  "Right, easy."
  Then ask for address naturally.

AFTER GETTING ADDRESS → Before asking urgency:
  "Oh right, I know that area actually." (use occasionally, not every time)
  "Got it, no worries."
  "Alright, good to know."
  Then ask about urgency.

AFTER GETTING URGENCY → Respond differently based on urgency:
  If urgent:
    "Yeah okay, we definitely don't want to leave that sitting then."
    "Right, yeah let's try and get onto that as soon as we can."
  If not urgent:
    "No worries, at least there's no rush. We'll still try to get to you soon though."
    "Okay cool, that gives us a bit of flexibility at least."

AFTER GETTING SERVICE TYPE → Before asking about the problem (if not already covered):
  "Yeah I do a fair bit of that actually."
  "Right, that's definitely something I can help with."

BEFORE ASKING PREFERRED TIME (last question):
  "Alright, just one more thing and we're all done."
  "Nearly there, just one last thing."
  "Okay we're almost wrapped up."

IMPORTANT: These are EXAMPLES — generate similar natural lines, don't memorize these.
The point is to sound human between every question. Keep transitions to ONE line max, then move on.

### HANDLING INTERRUPTIONS (FALSE BARGE-IN RECOVERY) ###
- Sometimes background noise (a door closing, a cough, traffic) may trigger an interruption even though the caller didn't actually say anything.
- If you get interrupted but the caller doesn't say anything meaningful, re-engage naturally:
  "Sorry, didn't catch that — what were you saying?"
  "Still there? All good. So yeah, [repeat the last question]"
  "Think we talked over each other — so what was your [repeat last question]?"
- NEVER go silent. If there's an awkward pause, YOU pick the conversation back up.
- Vary your recovery lines — don't say the exact same thing every time.

### THE BOOKING FLOW ###
You need to collect 7 things. Do it conversationally — not like a form.

1. NAME: "Hey! Jack here. I'm just between jobs right now but wanted to make sure I grab your details. Who am I speaking with?"

2. WARM TRANSITION (after getting name):
   - Greet them by name and ask what's going on. Let THEM tell you why they're calling.
   - From their response you'll likely pick up service type, problem description, maybe urgency or address.
   - Only ask for details they DIDN'T mention.

3. PHONE: "Right, and what's the best number to reach you on?"
4. ADDRESS: "And where's the job at? What's the address?"
5. URGENCY: "Would you say this is urgent, or is it more of a whenever-you-can kind of thing?"
6. SERVICE TYPE: (only if not already mentioned) "And what kind of work are we looking at — plumbing, electrical, something else?"
7. PROBLEM: (only if not already mentioned) "Can you describe what's actually going on?"
8. PREFERRED TIME: "When would work best for you? Any day or time you'd prefer?"

Don't force this order. If the caller volunteers info early, take it and skip those questions.
The key is: after getting the name, let the conversation BREATHE. Don't rapid-fire questions.

### OFF-TOPIC HANDLING ###
- Unrelated questions: "That's a bit outside what I can help with honestly. But anything tradie related, I've got you covered."
- Pricing questions: "Hard to give you an exact number over the phone — I'd really need to see the job first. But let me get your details and I'll come have a look."
- Deep technical questions: "That's a good question. Hard to say without seeing it in person though. Let me lock in your details and I'll come check it out properly."
- Always pivot back to collecting the remaining info.

### FINAL ACTION (CRITICAL) ###
- Once you have ALL 7 pieces of info, IMMEDIATELY call save_customer_booking. No confirmation. No summary. Just call it.
- After the tool returns success: "Awesome, you're all locked in! I'll give you a call to sort out the rest. Thanks [name], have a good one!"

### HARD RULES ###
- Language: English only
- ONE question at a time — never stack questions
- Keep responses SHORT — 1 to 2 sentences max
- If there's silence, re-engage naturally: "Still there?" or "Sorry, didn't catch that."
- Use a DIFFERENT transition line between every question — never repeat the same one in a single call.`;
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