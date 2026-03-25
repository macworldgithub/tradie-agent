import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import WebSocket from 'ws';
import { Customer, CustomerDocument } from './Schema/customer.schema';

interface RealtimeSession {
  ws: WebSocket;
  onEvent: (event: any) => void;
}

@Injectable()
export class VoiceService {
  private readonly logger = new Logger(VoiceService.name);
  private sessions = new Map<string, RealtimeSession>();

  constructor(
    private readonly config: ConfigService,
    @InjectModel(Customer.name)
    private readonly customerModel: Model<CustomerDocument>,
  ) {}

  /**
   * Opens a WebSocket to the OpenAI Realtime API and configures the session.
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
        this.logger.log(`[${sessionId}] Realtime WebSocket connected`);

        // Configure session
        const sessionUpdate = {
          type: 'session.update',
          session: {
            modalities: ['text', 'audio'],
            instructions: this.getSystemPrompt(),
            voice: 'alloy',
            output_audio_format: 'pcm16',
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 2000,
            },
            tools: [this.getSaveBookingTool()],
            tool_choice: 'auto',
          },
        };

        ws.send(JSON.stringify(sessionUpdate));

        // Wait for session.updated event before resolving, to ensure the prompt is active
        const timeout = setTimeout(() => {
          this.logger.warn(`[${sessionId}] session.updated timed out`);
          resolve();
        }, 5000);

        ws.on('message', function handler(data: WebSocket.Data) {
          try {
            const event = JSON.parse(data.toString());
            if (event.type === 'session.updated') {
              clearTimeout(timeout);
              ws.removeListener('message', handler);
              resolve();
            }
          } catch (e) {}
        });

        this.sessions.set(sessionId, { ws, onEvent });
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
        this.logger.error(`[${sessionId}] WebSocket error:`, err);
        onEvent({ type: 'error', error: { message: err.message } });
        reject(err);
      });

      ws.on('close', (code, reason) => {
        this.logger.log(
          `[${sessionId}] WebSocket closed: ${code} - ${reason}`,
        );
        this.sessions.delete(sessionId);
        onEvent({ type: 'session-closed' });
      });
    });
  }

  /**
   * Send a PCM16 audio chunk to the Realtime API.
   */
  sendAudio(sessionId: string, base64Audio: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.logger.warn(`[${sessionId}] No active session for audio`);
      return;
    }

    session.ws.send(
      JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: base64Audio,
      }),
    );
  }

  /**
   * Trigger an initial greeting from the model.
   */
  triggerGreeting(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Just trigger a response. The system instructions tell it how to START.
    session.ws.send(JSON.stringify({ type: 'response.create' }));
  }

  /**
   * Close the Realtime session.
   */
  closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.ws.close();
      this.sessions.delete(sessionId);
      this.logger.log(`[${sessionId}] Session closed`);
    }
  }

  /**
   * Handle incoming events from the Realtime API.
   */
  private async handleRealtimeEvent(
    sessionId: string,
    event: any,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    switch (event.type) {
      case 'session.created':
        this.logger.log(`[${sessionId}] session.created: ${event.session?.id}`);
        break;

      case 'session.updated':
        this.logger.log(`[${sessionId}] session.updated successfully`);
        break;

      case 'response.audio.delta':
        this.logger.verbose(`[${sessionId}] response.audio.delta received`);
        session.onEvent({
          type: 'audio-delta',
          delta: event.delta,
        });
        break;

      case 'response.audio_transcript.delta':
        // Forward transcript text to browser
        session.onEvent({
          type: 'transcript-delta',
          delta: event.delta,
        });
        break;

      case 'response.audio_transcript.done':
        session.onEvent({
          type: 'transcript-done',
          transcript: event.transcript,
        });
        break;

      case 'input_audio_buffer.speech_started':
        // The user started speaking — tell browser to stop playback (barge-in)
        session.onEvent({ type: 'speech-started' });
        break;

      case 'input_audio_buffer.speech_stopped':
        this.logger.log(`[${sessionId}] User stopped speaking`);
        break;

      case 'conversation.item.input_audio_transcription.completed':
        this.logger.log(`[${sessionId}] User transcribed: "${event.transcript}"`);
        session.onEvent({
          type: 'user-transcript',
          transcript: event.transcript,
        });
        break;

      case 'response.function_call_arguments.done':
        await this.handleFunctionCall(sessionId, event);
        break;

      case 'response.done':
        if (event.response?.status === 'failed') {
          this.logger.error(
            `[${sessionId}] Response failed:`,
            JSON.stringify(event.response.status_details),
          );
        }
        break;

      case 'error':
        this.logger.error(
          `[${sessionId}] Realtime API error:`,
          JSON.stringify(event.error),
        );
        session.onEvent({
          type: 'error',
          error: event.error,
        });
        break;

      default:
        // Ignore other events (rate_limits.updated, response.created, etc.)
        break;
    }
  }

  /**
   * Handle function calls from the Realtime model.
   */
  private async handleFunctionCall(
    sessionId: string,
    event: any,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (event.name === 'save_customer_booking') {
      this.logger.log(
        `[${sessionId}] Function call: save_customer_booking`,
      );

      try {
        this.logger.log(`[${sessionId}] Raw tool arguments: ${event.arguments}`);
        const args = JSON.parse(event.arguments);
        this.logger.log(
          `[${sessionId}] Saving booking to MongoDB: ${JSON.stringify(args)}`,
        );

        // Save to MongoDB
        const customer = await this.customerModel.create({
          name: args.name,
          phone: args.phone,
          address: args.address,
          urgency: args.urgency,
          serviceType: args.service_type,
          problemDescription: args.problem_description,
          preferredTime: args.preferred_time,
          summary: `Booking for ${args.name}: ${args.service_type} - ${args.problem_description} (${args.urgency})`,
        });

        this.logger.log(
          `[${sessionId}] Customer saved: ${customer._id}`,
        );

        // Send function result back to model
        session.ws.send(
          JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: event.call_id,
              output: JSON.stringify({
                success: true,
                message: `Booking successfully saved in database for ${args.name}.`,
              }),
            },
          }),
        );

        // Trigger the final confirmation message
        session.ws.send(JSON.stringify({ type: 'response.create' }));

        // Notify browser that booking was saved
        session.onEvent({
          type: 'booking-saved',
          data: args,
        });
      } catch (err) {
        this.logger.error(`[${sessionId}] Failed to save booking:`, err);

        session.ws.send(
          JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: event.call_id,
              output: JSON.stringify({
                success: false,
                message: 'Failed to save booking. Please try again.',
              }),
            },
          }),
        );

        session.ws.send(JSON.stringify({ type: 'response.create' }));
      }
    }
  }

  /**
   * System prompt for the Realtime voice agent.
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
   * Tool definition for the save_customer_booking function.
   */
  private getSaveBookingTool() {
    return {
      type: 'function',
      name: 'save_customer_booking',
      description:
        'Save the customer booking details to the database once all required information has been collected.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: "The customer's full name",
          },
          phone: {
            type: 'string',
            description: "The customer's phone number",
          },
          address: {
            type: 'string',
            description: 'The address where the service is needed',
          },
          urgency: {
            type: 'string',
            description:
              'How urgent the job is (e.g., emergency, urgent, can wait a few days)',
          },
          service_type: {
            type: 'string',
            description:
              'The type of service needed (e.g., plumbing, electrical, carpentry)',
          },
          problem_description: {
            type: 'string',
            description: 'A brief description of the problem',
          },
          preferred_time: {
            type: 'string',
            description:
              'The preferred day and time for the tradie to visit',
          },
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
}
