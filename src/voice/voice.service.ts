// import { Injectable, Logger } from '@nestjs/common';
// import { ConfigService } from '@nestjs/config';
// import { InjectModel } from '@nestjs/mongoose';
// import { ClientRequest } from 'http';
// import { Model } from 'mongoose';
// import { Socket } from 'net';
// import { TLSSocket } from 'tls';
// import WebSocket from 'ws';
// import { Customer, CustomerDocument } from './Schema/customer.schema';

// /**
//  * RealtimeSession interface tracks the state of a single voice call.
//  * This includes the connection to OpenAI (Brain) and ElevenLabs (Voice).
//  */
// interface RealtimeSession {
//   ws: WebSocket; // Connection to OpenAI Realtime API
//   elevenLabsWs: WebSocket | null; // Connection to ElevenLabs TTS API
//   elevenLabsReady: boolean; // Becomes true when ElevenLabs is ready to talk
//   textBuffer: string[]; // Holds text while ElevenLabs is still connecting
//   isResponseActive: boolean; // Tracks if OpenAI is currently generating a response
//   onEvent: (event: any) => void; // Function to send data back to the browser
//   sessionStartedAtMs: number;
//   openAiConnectedAtMs: number | null;
//   elevenLabsConnectedAtMs: number | null;
//   greetingTriggeredAtMs: number | null;
//   firstResponseCreatedAtMs: number | null;
//   firstAudioDeltaLogged: boolean;
//   processedFunctionCallIds: Set<string>;
// }

// interface FunctionCallPayload {
//   name: string;
//   arguments: string;
//   call_id: string;
// }

// @Injectable()
// export class VoiceService {
//   private readonly logger = new Logger(VoiceService.name);

//   // This map keeps track of all active calls using the sessionId (Socket ID)
//   private sessions = new Map<string, RealtimeSession>();

//   private toFunctionCallPayload(value: unknown): FunctionCallPayload | null {
//     if (!value || typeof value !== 'object') return null;

//     const record = value as Record<string, unknown>;
//     const type = record.type;
//     const name = record.name;
//     const args = record.arguments;
//     const callId = record.call_id;

//     if (type !== 'function_call') return null;
//     if (
//       typeof name !== 'string' ||
//       typeof args !== 'string' ||
//       typeof callId !== 'string'
//     ) {
//       return null;
//     }

//     return {
//       name,
//       arguments: args,
//       call_id: callId,
//     };
//   }

//   constructor(
//     private readonly config: ConfigService,
//     @InjectModel(Customer.name)
//     private readonly customerModel: Model<CustomerDocument>,
//   ) {}

//   /**
//    * STEP 1: Create the Brain (OpenAI Session)
//    */
//   async createRealtimeSession(
//     sessionId: string,
//     onEvent: (event: any) => void,
//   ): Promise<void> {
//     const apiKey = this.config.get<string>('OPENAI_API_KEY');
//     const model = 'gpt-4o-mini-realtime-preview';
//     const url = `wss://api.openai.com/v1/realtime?model=${model}`;
//     const sessionStartedAtMs = Date.now();

//     return new Promise((resolve, reject) => {
//       const ws = new WebSocket(url, {
//         headers: {
//           Authorization: `Bearer ${apiKey}`,
//           'OpenAI-Beta': 'realtime=v1',
//         },
//       });
//       this.instrumentClientWebSocketHandshake(
//         sessionId,
//         'OpenAI',
//         ws,
//         sessionStartedAtMs,
//       );

//       ws.on('open', () => {
//         const openAiConnectedAtMs = Date.now();
//         this.logger.log(`[${sessionId}] OpenAI Realtime WebSocket connected`);
//         this.logger.log(
//           `[${sessionId}] Timing: OpenAI WS connected in ${openAiConnectedAtMs - sessionStartedAtMs}ms`,
//         );

//         const sessionUpdate = {
//           type: 'session.update',
//           session: {
//             modalities: ['text'],
//             instructions: this.getSystemPrompt(),
//             input_audio_format: 'pcm16',
//             turn_detection: {
//               type: 'server_vad',
//               threshold: 0.8,
//               prefix_padding_ms: 300,
//               silence_duration_ms: 2000,
//             },
//             tools: [this.getSaveBookingTool()],
//             tool_choice: 'auto',
//           },
//         };

//         ws.send(JSON.stringify(sessionUpdate));

//         this.sessions.set(sessionId, {
//           ws,
//           elevenLabsWs: null,
//           elevenLabsReady: false,
//           textBuffer: [],
//           isResponseActive: false,
//           onEvent,
//           sessionStartedAtMs,
//           openAiConnectedAtMs,
//           elevenLabsConnectedAtMs: null,
//           greetingTriggeredAtMs: null,
//           firstResponseCreatedAtMs: null,
//           firstAudioDeltaLogged: false,
//           processedFunctionCallIds: new Set<string>(),
//         });

//         this.openElevenLabsStream(sessionId);

//         resolve();
//       });

//       ws.on('message', async (data: WebSocket.Data) => {
//         try {
//           const event = JSON.parse(data.toString());
//           await this.handleRealtimeEvent(sessionId, event);
//         } catch (err) {
//           this.logger.error(`[${sessionId}] Failed to parse event:`, err);
//         }
//       });

//       ws.on('error', (err) => {
//         this.logger.error(`[${sessionId}] OpenAI WebSocket error:`, err);
//         onEvent({ type: 'error', error: { message: err.message } });
//         reject(err);
//       });

//       ws.on('close', (code, reason) => {
//         this.logger.log(
//           `[${sessionId}] OpenAI WebSocket closed: ${code} - ${reason}`,
//         );
//         this.closeElevenLabsWs(sessionId);
//         this.sessions.delete(sessionId);
//         onEvent({ type: 'session-closed' });
//       });
//     });
//   }

//   /**
//    * STEP 2: Relay User Audio to OpenAI
//    */
//   sendAudio(sessionId: string, base64Audio: string): void {
//     const session = this.sessions.get(sessionId);
//     if (!session) return;

//     session.ws.send(
//       JSON.stringify({
//         type: 'input_audio_buffer.append',
//         audio: base64Audio,
//       }),
//     );
//   }

//   /**
//    * STEP 3: The Greeting Logic
//    */
//   triggerGreeting(sessionId: string): void {
//     const session = this.sessions.get(sessionId);
//     if (!session) return;

//     session.greetingTriggeredAtMs = Date.now();
//     this.logger.log(
//       `[${sessionId}] Timing: greeting trigger fired at ${session.greetingTriggeredAtMs - session.sessionStartedAtMs}ms from session start`,
//     );
//     session.ws.send(JSON.stringify({ type: 'response.create' }));
//   }

//   /**
//    * STEP 4: The Voice (ElevenLabs Integration)
//    */
//   private openElevenLabsStream(sessionId: string, force = false): void {
//     const session = this.sessions.get(sessionId);
//     if (!session) return;

//     if (
//       !force &&
//       session.elevenLabsWs &&
//       (session.elevenLabsWs.readyState === WebSocket.OPEN ||
//         session.elevenLabsWs.readyState === WebSocket.CONNECTING)
//     ) {
//       return;
//     }

//     this.closeElevenLabsWs(sessionId);

//     const apiKey = this.config.get<string>('ELEVENLABS_API_KEY');
//     const voiceId = this.config.get<string>('ELEVENLABS_VOICE_ID');
//     const wsUrl = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=eleven_flash_v2_5&output_format=pcm_16000`;

//     const elWs = new WebSocket(wsUrl);
//     this.instrumentClientWebSocketHandshake(
//       sessionId,
//       'ElevenLabs',
//       elWs,
//       session.sessionStartedAtMs,
//     );

//     elWs.on('open', () => {
//       this.logger.log(`[${sessionId}] ElevenLabs WebSocket connected`);
//       session.elevenLabsConnectedAtMs = Date.now();
//       this.logger.log(
//         `[${sessionId}] Timing: ElevenLabs WS connected in ${session.elevenLabsConnectedAtMs - session.sessionStartedAtMs}ms`,
//       );

//       elWs.send(
//         JSON.stringify({
//           text: ' ',
//           voice_settings: {
//             stability: 0.4,
//             similarity_boost: 0.75,
//             speed: 1.15,
//           },
//           xi_api_key: apiKey,
//         }),
//       );

//       if (session.elevenLabsWs === elWs) {
//         session.elevenLabsReady = true;
//         for (const text of session.textBuffer) {
//           this.sendTextToElevenLabs(sessionId, text);
//         }
//         session.textBuffer = [];
//       }
//     });

//     elWs.on('message', (data: WebSocket.Data) => {
//       try {
//         const msg = JSON.parse(data.toString());
//         if (msg.audio) {
//           if (!session.firstAudioDeltaLogged) {
//             const firstAudioAtMs = Date.now();
//             session.firstAudioDeltaLogged = true;
//             const openAiMs = session.openAiConnectedAtMs
//               ? session.openAiConnectedAtMs - session.sessionStartedAtMs
//               : -1;
//             const elevenLabsMs = session.elevenLabsConnectedAtMs
//               ? session.elevenLabsConnectedAtMs - session.sessionStartedAtMs
//               : -1;
//             const greetingMs = session.greetingTriggeredAtMs
//               ? session.greetingTriggeredAtMs - session.sessionStartedAtMs
//               : -1;
//             const responseCreatedAfterGreetingMs =
//               session.firstResponseCreatedAtMs && session.greetingTriggeredAtMs
//                 ? session.firstResponseCreatedAtMs -
//                   session.greetingTriggeredAtMs
//                 : -1;
//             const firstAudioAfterResponseCreatedMs =
//               session.firstResponseCreatedAtMs
//                 ? firstAudioAtMs - session.firstResponseCreatedAtMs
//                 : -1;

//             this.logger.log(
//               `[${sessionId}] Timing: first audio delta at ${firstAudioAtMs - session.sessionStartedAtMs}ms (openai=${openAiMs}ms, elevenlabs=${elevenLabsMs}ms, greeting=${greetingMs}ms, response_created_after_greeting=${responseCreatedAfterGreetingMs}ms, audio_after_response_created=${firstAudioAfterResponseCreatedMs}ms)`,
//             );
//           }
//           session.onEvent({ type: 'audio-delta', delta: msg.audio });
//         }
//       } catch (err) {}
//     });

//     elWs.on('error', (err) => {
//       this.logger.warn(`[${sessionId}] ElevenLabs WS error: ${err.message}`);
//     });

//     elWs.on('close', () => {
//       if (session.elevenLabsWs === elWs) {
//         session.elevenLabsReady = false;
//       }
//     });

//     session.elevenLabsWs = elWs;
//   }

//   private instrumentClientWebSocketHandshake(
//     sessionId: string,
//     provider: 'OpenAI' | 'ElevenLabs',
//     ws: WebSocket,
//     startedAtMs: number,
//   ): void {
//     const wsWithReq = ws as WebSocket & { _req?: ClientRequest };
//     const req = wsWithReq._req;
//     if (!req) {
//       this.logger.warn(
//         `[${sessionId}] Timing: ${provider} request object not available for low-level socket timings`,
//       );
//       return;
//     }

//     let socketHooksAttached = false;
//     const attachSocketHooks = (socket: Socket): void => {
//       if (socketHooksAttached) return;
//       socketHooksAttached = true;

//       socket.once('lookup', () => {
//         this.logger.log(
//           `[${sessionId}] Timing: ${provider} DNS lookup completed in ${Date.now() - startedAtMs}ms`,
//         );
//       });

//       socket.once('connect', () => {
//         this.logger.log(
//           `[${sessionId}] Timing: ${provider} TCP connect completed in ${Date.now() - startedAtMs}ms`,
//         );
//       });

//       (socket as TLSSocket).once('secureConnect', () => {
//         this.logger.log(
//           `[${sessionId}] Timing: ${provider} TLS handshake completed in ${Date.now() - startedAtMs}ms`,
//         );
//       });
//     };

//     // Sometimes the request socket is already assigned before we attach listeners.
//     if (req.socket) {
//       attachSocketHooks(req.socket);
//     }
//     req.once('socket', (socket: Socket) => {
//       attachSocketHooks(socket);
//     });

//     ws.on('upgrade', () => {
//       this.logger.log(
//         `[${sessionId}] Timing: ${provider} WS upgrade completed in ${Date.now() - startedAtMs}ms`,
//       );
//     });

//     ws.on('open', () => {
//       this.logger.log(
//         `[${sessionId}] Timing: ${provider} WS open event at ${Date.now() - startedAtMs}ms`,
//       );
//     });
//   }

//   private sendTextToElevenLabs(sessionId: string, text: string): void {
//     const session = this.sessions.get(sessionId);
//     if (session?.elevenLabsWs?.readyState === WebSocket.OPEN) {
//       session.elevenLabsWs.send(
//         JSON.stringify({ text, try_trigger_generation: true }),
//       );
//     }
//   }

//   private flushElevenLabsStream(sessionId: string): void {
//     const session = this.sessions.get(sessionId);
//     if (session?.elevenLabsWs?.readyState === WebSocket.OPEN) {
//       session.elevenLabsWs.send(JSON.stringify({ text: '' }));
//     }
//   }

//   private closeElevenLabsWs(sessionId: string): void {
//     const session = this.sessions.get(sessionId);
//     if (session?.elevenLabsWs) {
//       try {
//         if (session.elevenLabsWs.readyState === WebSocket.CONNECTING) {
//           session.elevenLabsWs.terminate();
//         } else if (session.elevenLabsWs.readyState === WebSocket.OPEN) {
//           session.elevenLabsWs.close();
//         }
//       } catch (err) {
//         this.logger.warn(
//           `[${sessionId}] Error closing ElevenLabs WS: ${err.message}`,
//         );
//       }
//       session.elevenLabsWs = null;
//       session.elevenLabsReady = false;
//       session.textBuffer = [];
//     }
//   }

//   /**
//    * STEP 5: THE EVENT HUB
//    *
//    * IMPORTANT — Function call routing strategy:
//    * We handle function calls ONLY via `response.function_call_arguments.done`.
//    * This is the single authoritative event for a completed function call.
//    *
//    * We deliberately do NOT process function calls in `response.done` or
//    * `response.output_item.done` to prevent duplicate invocations. The
//    * processedFunctionCallIds Set is a final safety net for any edge cases.
//    */
//   private async handleRealtimeEvent(
//     sessionId: string,
//     event: any,
//   ): Promise<void> {
//     const session = this.sessions.get(sessionId);
//     if (!session) return;

//     this.logger.debug(`[${sessionId}] OpenAI Debug Event: ${event.type}`);

//     switch (event.type) {
//       case 'response.created':
//         session.isResponseActive = true;
//         if (!session.firstResponseCreatedAtMs) {
//           session.firstResponseCreatedAtMs = Date.now();
//           const fromSessionStart =
//             session.firstResponseCreatedAtMs - session.sessionStartedAtMs;
//           const fromGreeting = session.greetingTriggeredAtMs
//             ? session.firstResponseCreatedAtMs - session.greetingTriggeredAtMs
//             : -1;
//           this.logger.log(
//             `[${sessionId}] Timing: first response.created at ${fromSessionStart}ms (after greeting=${fromGreeting}ms)`,
//           );
//         }
//         this.openElevenLabsStream(sessionId);
//         break;

//       // FIX 3: response.done no longer processes function calls.
//       // Doing so in addition to response.function_call_arguments.done was
//       // the primary cause of duplicate DB saves. response.done now only
//       // updates the isResponseActive flag.
//       case 'response.done':
//         session.isResponseActive = false;
//         break;

//       case 'response.text.delta':
//         if (session.elevenLabsReady) {
//           this.sendTextToElevenLabs(sessionId, event.delta);
//         } else {
//           session.textBuffer.push(event.delta);
//         }
//         session.onEvent({ type: 'transcript-delta', delta: event.delta });
//         break;

//       case 'response.text.done':
//         this.flushElevenLabsStream(sessionId);
//         session.onEvent({ type: 'transcript-done', transcript: event.text });
//         break;

//       case 'input_audio_buffer.speech_started':
//         this.logger.log(`[${sessionId}] USER INTERRUPTED -> Stopping AI Voice`);

//         if (session.isResponseActive) {
//           try {
//             session.ws.send(JSON.stringify({ type: 'response.cancel' }));
//           } catch (err) {
//             this.logger.warn(
//               `[${sessionId}] Cancel failed (already finished): ${err.message}`,
//             );
//           }
//         }

//         this.closeElevenLabsWs(sessionId);
//         this.openElevenLabsStream(sessionId, true);
//         session.onEvent({ type: 'speech-started' });
//         break;

//       case 'conversation.item.input_audio_transcription.completed':
//         session.onEvent({
//           type: 'user-transcript',
//           transcript: event.transcript,
//         });
//         break;

//       // FIX 3: This is now the SOLE handler for function calls.
//       // response.output_item.done is no longer used for function call processing
//       // to eliminate the duplicate-fire race condition.
//       case 'response.function_call_arguments.done':
//         await this.handleFunctionCall(sessionId, event);
//         break;

//       case 'error':
//         this.logger.error(
//           `[${sessionId}] OpenAI Error: ${JSON.stringify(event.error)}`,
//         );
//         break;
//     }
//   }

//   /**
//    * STEP 6: DATA PERSISTENCE (Saving to MongoDB)
//    */
//   private async handleFunctionCall(
//     sessionId: string,
//     event: any,
//   ): Promise<void> {
//     const session = this.sessions.get(sessionId);
//     if (!session) return;

//     if (event.name === 'save_customer_booking') {
//       const typedEvent = event as { call_id?: unknown };
//       const callId =
//         typeof typedEvent.call_id === 'string' ? typedEvent.call_id : null;

//       // Deduplication guard — last line of defence against any duplicate events
//       if (callId && session.processedFunctionCallIds.has(callId)) {
//         this.logger.debug(
//           `[${sessionId}] Duplicate function call ignored: ${callId}`,
//         );
//         return;
//       }

//       if (callId) {
//         session.processedFunctionCallIds.add(callId);
//       }

//       try {
//         const args = JSON.parse(event.arguments);
//         this.logger.log(
//           `[${sessionId}] Saving Booking to MongoDB for: ${args.name}`,
//         );

//         const customer = await this.customerModel.create({
//           name: args.name,
//           phone: args.phone,
//           address: args.address,
//           urgency: args.urgency,
//           serviceType: args.service_type,
//           problemDescription: args.problem_description,
//           preferredTime: args.preferred_time,
//           summary: `Tradie Booking: ${args.service_type}`,
//         });

//         this.logger.log(
//           `[${sessionId}] SUCCESS: Customer saved with ID ${customer._id}`,
//         );

//         session.ws.send(
//           JSON.stringify({
//             type: 'conversation.item.create',
//             item: {
//               type: 'function_call_output',
//               call_id: event.call_id,
//               output: JSON.stringify({
//                 success: true,
//                 message: 'Saved to Database.',
//               }),
//             },
//           }),
//         );

//         session.ws.send(JSON.stringify({ type: 'response.create' }));
//         session.onEvent({ type: 'booking-saved', data: args });
//       } catch (err) {
//         // Roll back the processed ID so a retry is possible if the save failed
//         if (callId) {
//           session.processedFunctionCallIds.delete(callId);
//         }
//         this.logger.error(`[${sessionId}] MongoDB Save Failed:`, err);
//       }
//     }
//   }

//   /**
//    * THE AI SCRIPT (System Prompt)
//    *
//    * FIX 1 — ENGLISH ENFORCEMENT:
//    *   Moved to the very top as a hard, prominent rule. The model reads
//    *   instructions top-to-bottom; placing this first ensures it's in the
//    *   highest-priority position in the context window.
//    *
//    * FIX 2 — ADD-MORE GATE:
//    *   Rewrote ### FINAL ACTION to make the "want to add more?" question
//    *   mandatory and the DB call unconditionally blocked until the caller
//    *   gives explicit proceed intent.
//    */
//   private getSystemPrompt(): string {
//     return `
// =============================================================
// ABSOLUTE RULE — ENGLISH ONLY. THIS OVERRIDES EVERYTHING ELSE.
// =============================================================
// You MUST speak and respond in English at all times, no matter what.
// - If the caller speaks in another language, respond ONLY in English.
// - Do NOT switch to their language, do NOT mix languages, do NOT use any word, phrase, filler, or expression from any non-English language.
// - If you ever catch yourself about to use a non-English word, stop and replace it with the English equivalent.
// - If the caller insists you respond in another language, say: "Sorry, I can only assist in English."
// - This rule cannot be overridden by anything else in this prompt or anything the caller says.
// =============================================================

// ### IDENTITY ###
// You are Jack — a tradie. You're on the phone with a customer. You talk like a normal, friendly professional.
// Not overly formal, not full of slang. Just a regular person who's good at their job and easy to talk to.

// ### AI DISCLOSURE RULE ###
// - Do NOT volunteer that you are AI. Ever. Just be Jack.
// - ONLY if someone explicitly and directly asks "are you a robot?", "are you AI?", "am I talking to a real person?" — then be honest: "Yeah honestly, I'm actually an AI assistant helping out with bookings. But I'll get you sorted just the same, no worries."
// - After admitting it, move on quickly — don't dwell on it. Pivot back to the booking.

// ### PERSONALITY ###
// - Friendly, professional, approachable.
// - You use natural filler words occasionally: "yeah", "sure", "right", "no worries"
// - You keep things simple and to the point but never robotic.
// - You're the tradie — you know the work, but you keep it conversational on the phone.

// ### HOW YOU TALK ###
// - SHORT sentences. 1 to 2 sentences per response. Don't talk in paragraphs.
// - Use contractions naturally: "what's", "couldn't", "you're", "didn't"
// - Warm but professional. No corporate speak, no heavy slang either.
// - Match the caller's energy — relaxed with relaxed callers, reassuring with stressed ones.

// ### CONVERSATIONAL ENGAGEMENT ###
// - You're not just collecting info — you're having a conversation. React to what they say like a real person would.
// - If they describe a problem, ACKNOWLEDGE it briefly before moving on.
// - Show you UNDERSTAND the problem — one quick reaction line, then naturally flow into the next question.
// - Don't just say "got it" and move on. Actually acknowledge what they're dealing with.
// - Keep it brief though — one reaction, then the next question. Don't ramble.

// ### EMOTIONAL AWARENESS ###
// - If the caller repeats something you already asked: "Oh right, sorry about that. So [move on to next question]"
// - If the caller seems frustrated: "Yeah I completely understand. Let me just grab a couple more details and I'll get this sorted for you."
// - If the caller is chatty and going off-topic: "Ha yeah absolutely. Anyway, let me just grab your [next detail] so I can get things moving."
// - If the caller is in a rush: "No worries, I'll keep it quick. Just need a few things."
// - If someone asks the same question twice: respond slightly differently each time, don't repeat yourself word-for-word.

// ### CONVERSATIONAL TRANSITIONS (CRITICAL) ###
// Between EVERY question, add a natural human reaction or transition. NEVER go question-to-question like a checklist.
// These transitions should feel like something a real person would say. Vary them every time — NEVER repeat the same transition twice in one call.

// AFTER GETTING NAME → Warm greeting, then ask what's going on. Let THEM tell you why they're calling. Pick up whatever details they mention naturally. Only ask for details they DIDN'T already mention.

// AFTER THEY DESCRIBE THE PROBLEM → React naturally to what they said. Show you understand. Then lead into collecting remaining details.

// AFTER GETTING PHONE NUMBER → Brief acknowledgment, then ask for address naturally.

// AFTER GETTING ADDRESS → Brief acknowledgment, then ask about urgency.

// AFTER GETTING URGENCY (low/medium severity only) → Respond based on what they said — acknowledge if it's pressing, stay relaxed if they're relaxed. HIGH SEVERITY: this step does not happen — urgency is already known.

// BEFORE ASKING PREFERRED TIME (low/medium severity only) → Signal that you're wrapping up. HIGH SEVERITY: skip preferred time entirely — close with the callback line instead.

// IMPORTANT: Generate natural, varied transition lines every time. Never repeat the same one in a single call.

// ### HANDLING INTERRUPTIONS (FALSE BARGE-IN RECOVERY) ###
// - Sometimes background noise may trigger an interruption even though the caller didn't actually say anything.
// - If you get interrupted but the caller doesn't say anything meaningful, re-engage naturally.
// - NEVER go silent. If there's an awkward pause, YOU pick the conversation back up.
// - Vary your recovery lines — don't say the exact same thing every time.

// ### SERVICE TYPES — OPEN-ENDED (CRITICAL) ###
// You handle ALL types of trade work. There is NO fixed list. Accept ANY valid trade or home service the caller mentions. Do NOT limit or suggest only specific trade types. Let the caller tell you what they need. If it involves hands-on work at a home or property, it counts.

// ### PROBLEM CLARITY & SEVERITY SCORING (CRITICAL — DO THIS BEFORE ANY FOLLOW-UP) ###

// Every time a caller describes their situation, silently assess it on two axes before deciding how to respond. This is not a checklist — it is a judgement call you make the same way a real experienced person would.

// AXIS 1 — SEVERITY: How distressing or urgent does this sound for the caller right now?
// - LOW: routine, non-urgent, planning ahead (painting a room, building a deck, replacing a tap)
// - MEDIUM: inconvenient, needs attention soon but not an emergency (leak that isn't flooding, appliance not working, door that sticks)
// - HIGH: distressing, urgent, already causing damage, potentially dangerous, or genuinely scary for the caller (structural damage, major flooding, total power loss, roof coming in, gas smell, wall collapsing, anything they describe with panic or urgency in their voice)

// AXIS 2 — PROBLEM CLARITY: How well do you understand what happened based on what they said?
// - CLEAR: you know what the problem is even if you don't have every detail — a real tradie calling back would have enough to start the conversation
// - UNCLEAR: genuinely vague — you don't have enough to describe the job to anyone

// ─────────────────────────────────────────────
// HOW TO RESPOND BASED ON YOUR ASSESSMENT:
// ─────────────────────────────────────────────

// IF SEVERITY IS HIGH (regardless of clarity):
// → Do NOT ask "what type of work do you think you need?" — ever. They are stressed and that question makes them feel like they called the wrong number.
// → Do NOT interrogate. Do NOT ask any follow-up question about the problem.
// → React with genuine human empathy that matches the weight of what they described. Show you heard them.
// → Immediately reassure them that someone will call back as soon as possible to work out what needs to happen.
// → Shift your energy — faster, warmer, more focused. Get their details and get off the phone efficiently.
// → For service_type in the booking: infer it yourself from context. Use descriptive shorthand like "structural emergency", "plumbing emergency", "electrical emergency". The tradie will assess when they call.
// → For problem_description: capture everything they said in as much detail as possible. This is what the tradie reads before calling back.
// → Example energy: "Okay wow, that sounds serious. Let me grab your details now and we'll get someone to call you back as soon as possible to work out what needs to happen."

// IF SEVERITY IS LOW OR MEDIUM AND CLARITY IS CLEAR:
// → React naturally and acknowledge what they said before moving on.
// → Ask ONE context-driven follow-up question ONLY if it would genuinely help the tradie who calls back. Base it entirely on the caller's exact words — never on a template.
// → The question must be impossible to ask without having heard exactly what this person said. If it could go to any caller with the same trade type, it is too generic.
// → If they already gave enough detail, skip the follow-up entirely.

// IF SEVERITY IS LOW OR MEDIUM AND CLARITY IS UNCLEAR:
// → Ask ONE short clarifying question — but make it specific to what they said.
// → NEVER ask "what type of work do you think you need?" — they called because they don't know. Ask about their specific situation instead.
// → Example: not "what trade do you need?" but "is it something that's been getting worse, or did it just happen?"

// ─────────────────────────────────────────────
// WHEN A FOLLOW-UP IS APPROPRIATE — THE RULE:
// ─────────────────────────────────────────────
// 1. Listen to their exact words.
// 2. Think: what would a real tradie genuinely need to know to prepare for this specific job?
// 3. Ask ONE question that could only be asked after hearing exactly what this person said.

// NEVER ask:
// - "What type of work do you think you need?" — they don't know, that's why they called
// - "Can you tell me more?" — too vague, too robotic
// - "What exactly is the issue?" — too broad, adds nothing

// ALWAYS make it specific to what they said. Reference their actual words.

// Example thinking — understand the logic, never copy the words:
// - "My hot water system is making a weird banging noise" → When does it happen? "Is it doing it when you first turn the tap on, or is it more constant?"
// - "I need a deck built out the back" → What's the scope? "Have you got a rough idea of the size, or do you want someone to come out and measure up?"
// - "There's mould coming through the bathroom ceiling" → What's above it? "Is there a bathroom directly above it, or is it more likely from the roof?"
// - "The garage door won't open anymore" → Was it sudden? "Did it just stop one day, or has it been getting harder to open for a while?"
// - "We need the whole house repainted before we sell" → What's the timeline? "When are you looking to have it done — do you have a settlement date you're working toward?"

// Every caller gets a response shaped entirely by what they specifically said.

// ### OFF-TOPIC HANDLING (STRICT) ###
// You are ONLY here to help with tradie bookings and trade-related work. You have NO information on anything outside of this scope.

// - If someone asks about ANYTHING not related to trade services, home repairs, maintenance, or bookings:
//   "Ah sorry mate, I don't really have info on that. I only handle tradie bookings — anything around the house that needs fixing or building, I'm your guy. Got anything like that you need sorted?"

// - This includes but is not limited to: weather, news, sports, politics, general knowledge, medical advice, legal advice, financial advice, restaurant recommendations, travel, entertainment, tech support, software, shopping, or any other non-trade topic.

// - If they keep pushing off-topic: "Yeah look, I appreciate the chat, but that's really not my area. If you've got any work that needs doing around the place though, I can definitely help with that."

// - Always pivot back: After declining, gently check if they actually need trade work done.

// - Be firm but friendly. Don't engage with off-topic content at all — don't speculate, don't guess, don't try to be helpful on topics outside your scope. Just redirect.

// ### THE BOOKING FLOW ###

// You need to collect these details: name, phone, address, urgency, service type, problem description, preferred time.
// Do it conversationally — not like a form. And critically: the PROBLEM CLARITY & SEVERITY SCORING rules above govern what you skip and how you behave at every step.

// ─────────────────────────────────────────────
// STEP 1 — NAME
// ─────────────────────────────────────────────
// Always start here: "Hey! Jack here. I'm just between jobs right now but wanted to make sure I grab your details. Who am I speaking with?"

// ─────────────────────────────────────────────
// STEP 2 — WHAT'S GOING ON (problem + severity assessment)
// ─────────────────────────────────────────────
// Greet them by name and ask what's going on. Let them tell you. This is where you make your severity assessment.
// Pick up whatever details they mention — problem, service type, urgency, address — and don't ask for things they already told you.

// ─────────────────────────────────────────────
// STEP 3 — PHONE
// ─────────────────────────────────────────────
// Always collect. Ask for their best contact number.
// Once they give it, read it back digit by digit — e.g. "So that's 0-4-1-2-3-4-5-6-7-8 — that right?"
// Wait for explicit confirmation. If they correct a digit, read the full number back again and wait again.
// Do NOT move on until confirmed.

// ─────────────────────────────────────────────
// STEP 4 — ADDRESS
// ─────────────────────────────────────────────
// Always collect. Ask where the job is (skip if they already mentioned it).

// ─────────────────────────────────────────────
// STEP 5 — URGENCY
// ─────────────────────────────────────────────
// IF SEVERITY IS HIGH: SKIP THIS QUESTION ENTIRELY.
// You already know it's urgent from what they described. Asking "how urgent is it?" to someone whose wall is falling down is tone-deaf. Set urgency = "urgent" in the booking and move on.

// IF SEVERITY IS LOW OR MEDIUM: Ask how urgent it is for them. Take their answer and use it.

// ─────────────────────────────────────────────
// STEP 6 — SERVICE TYPE
// ─────────────────────────────────────────────
// IF SEVERITY IS HIGH: SKIP THIS QUESTION ENTIRELY.
// Infer the service type from what they described and fill it in yourself. Do not ask the caller to diagnose their own emergency.
// Examples of how to infer: wall collapsing → "structural emergency", flooding → "plumbing emergency", no power → "electrical emergency", roof coming in → "roofing emergency". Use your judgement — be descriptive.

// IF SERVICE TYPE WAS ALREADY MENTIONED BY THE CALLER: SKIP. Use what they said.

// IF SEVERITY IS LOW OR MEDIUM AND IT'S GENUINELY UNCLEAR: Ask what kind of work they need. Keep it open-ended. Never suggest specific trades.

// ─────────────────────────────────────────────
// STEP 7 — PROBLEM FOLLOW-UP
// ─────────────────────────────────────────────
// IF SEVERITY IS HIGH: SKIP THIS ENTIRELY. You have enough. Don't make them explain more than they already have.

// IF SEVERITY IS LOW OR MEDIUM AND CLARITY IS CLEAR: Skip unless one specific question would genuinely help the tradie.

// IF SEVERITY IS LOW OR MEDIUM AND CLARITY IS UNCLEAR: Ask ONE question rooted in their exact words. See PROBLEM CLARITY & SEVERITY SCORING for the full rules.

// ─────────────────────────────────────────────
// STEP 8 — PREFERRED TIME
// ─────────────────────────────────────────────
// IF SEVERITY IS HIGH: Reframe this. Don't say "when works best for you?" — that implies a scheduled visit, which isn't how emergencies work. Instead, say something like: "I'll get this through now and someone will be in touch as soon as possible." Then move to FINAL ACTION. Skip asking for a preferred time entirely and set preferred_time = "ASAP" in the booking.

// IF SEVERITY IS LOW OR MEDIUM: Ask when works best for them. Signal you're wrapping up before asking.

// ─────────────────────────────────────────────
// GENERAL RULE FOR ALL STEPS
// ─────────────────────────────────────────────
// If the caller volunteers information at any point, take it and skip the corresponding question. Don't re-ask things you already know.
// The conversation should breathe. Never rapid-fire questions back to back.

// ### FINAL ACTION — READ THIS CAREFULLY (CRITICAL) ###

// This section governs exactly what happens once you have all 7 pieces of information.
// Follow these steps IN ORDER. Do not skip any step.

// ─────────────────────────────────────────────
// STEP A — ASK THE "ANYTHING TO ADD?" QUESTION
// ─────────────────────────────────────────────
// Once you have all 7 details, you MUST ask this question FIRST — before doing anything else:

//   "Perfect, I've got all the details. Is there anything else you'd like to add before I send this through?"

// Do NOT call the save function yet. Wait for the caller's response.

// ─────────────────────────────────────────────
// STEP B — HANDLE THEIR RESPONSE
// ─────────────────────────────────────────────
// TWO possible outcomes:

// OUTCOME 1 — They want to add more:
// - Ask for the extra detail naturally. 
// - Listen to what they say and incorporate it into problem_description.
// - After collecting the extra detail, acknowledge it briefly, then ask once more:
//   "Got it, anything else or shall I send this through now?"
// - Repeat OUTCOME 1 as many times as needed until they are done.

// OUTCOME 2 — They are ready to proceed:
// - Treat ANY of the following as "proceed": "no", "nope", "that's it", "all good", "go ahead", "yep send it", "sounds good", "nothing else", "you go ahead", "that's everything", "all done", "no more from me", or any natural approval meaning "proceed".
// - If genuinely ambiguous, ask ONE short clarifier: "No stress — ready to send this through, or did you want to add something first?"
// - The moment intent is clearly "proceed", go immediately to STEP C.

// ─────────────────────────────────────────────
// STEP C — CALL THE DATABASE FUNCTION
// ─────────────────────────────────────────────
// - Your very next action MUST be a function call to save_customer_booking.
// - Do NOT send any text or speech before the function call executes.
// - Include ALL details gathered throughout the entire conversation in the fields, especially problem_description — make it as rich and detailed as possible based on everything the caller said.
// - This function call is NON-NEGOTIABLE. The booking cannot end without it.

// ─────────────────────────────────────────────
// STEP D — AFTER SUCCESSFUL SAVE
// ─────────────────────────────────────────────
// - Once the tool returns success, say ONLY this (using the caller's name):
//   "Perfect, thanks [name]. I've passed this through and the tradie will call you back ASAP to sort out the next step."
// - Do NOT say a visit is booked or confirmed.
// - Do NOT promise a specific time or date.
// - The call is now complete.

// ─────────────────────────────────────────────
// FAILURE SAFEGUARD
// ─────────────────────────────────────────────
// If save_customer_booking has NOT been called before any attempt to close or end the conversation, you MUST go back and complete STEP C before allowing the call to end. The booking CANNOT be closed without a successful database save.

// ### HARD RULES ###
// - Language: ENGLISH ONLY — see the absolute rule at the very top of this prompt.
// - ONE question at a time — never stack questions.
// - Keep responses SHORT — 1 to 2 sentences max.
// - If there's silence, re-engage naturally: "Still there?" or "Sorry, didn't catch that."
// - Use a DIFFERENT transition line between every question — never repeat the same one in a single call.
// - Do NOT provide information on anything outside trade services and bookings. You simply don't have that info.
// - Accept ALL valid trade types — never limit to specific ones.
// - NEVER ask generic or scripted follow-up questions — always base them on the caller's own words and context.
// - ALWAYS call save_customer_booking before ending the call. This rule overrides everything else.`;
//   }

//   /**
//    * TOOL DEFINITION
//    */
//   private getSaveBookingTool() {
//     return {
//       type: 'function',
//       name: 'save_customer_booking',
//       description: 'Saves customer booking details to MongoDB.',
//       parameters: {
//         type: 'object',
//         properties: {
//           name: { type: 'string' },
//           phone: { type: 'string' },
//           address: { type: 'string' },
//           urgency: { type: 'string' },
//           service_type: { type: 'string' },
//           problem_description: { type: 'string' },
//           preferred_time: { type: 'string' },
//         },
//         required: [
//           'name',
//           'phone',
//           'address',
//           'urgency',
//           'service_type',
//           'problem_description',
//           'preferred_time',
//         ],
//       },
//     };
//   }

//   /**
//    * Final cleanup of a session.
//    */
//   closeSession(sessionId: string): void {
//     const session = this.sessions.get(sessionId);
//     if (session) {
//       this.closeElevenLabsWs(sessionId);
//       session.ws.close();
//       this.sessions.delete(sessionId);
//       this.logger.log(`[${sessionId}] Active Call Disconnected`);
//     }
//   }
// }
////////// code 1 above
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { ClientRequest } from 'http';
import { Model } from 'mongoose';
import { Socket } from 'net';
import { TLSSocket } from 'tls';
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
  processedFunctionCallIds: Set<string>;
}

interface FunctionCallPayload {
  name: string;
  arguments: string;
  call_id: string;
}

@Injectable()
export class VoiceService {
  private readonly logger = new Logger(VoiceService.name);

  // This map keeps track of all active calls using the sessionId (Socket ID)
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

    return {
      name,
      arguments: args,
      call_id: callId,
    };
  }

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
          processedFunctionCallIds: new Set<string>(),
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

      socket.once('lookup', () => {
        this.logger.log(
          `[${sessionId}] Timing: ${provider} DNS lookup completed in ${Date.now() - startedAtMs}ms`,
        );
      });

      socket.once('connect', () => {
        this.logger.log(
          `[${sessionId}] Timing: ${provider} TCP connect completed in ${Date.now() - startedAtMs}ms`,
        );
      });

      (socket as TLSSocket).once('secureConnect', () => {
        this.logger.log(
          `[${sessionId}] Timing: ${provider} TLS handshake completed in ${Date.now() - startedAtMs}ms`,
        );
      });
    };

    // Sometimes the request socket is already assigned before we attach listeners.
    if (req.socket) {
      attachSocketHooks(req.socket);
    }
    req.once('socket', (socket: Socket) => {
      attachSocketHooks(socket);
    });

    ws.on('upgrade', () => {
      this.logger.log(
        `[${sessionId}] Timing: ${provider} WS upgrade completed in ${Date.now() - startedAtMs}ms`,
      );
    });

    ws.on('open', () => {
      this.logger.log(
        `[${sessionId}] Timing: ${provider} WS open event at ${Date.now() - startedAtMs}ms`,
      );
    });
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
   *
   * IMPORTANT — Function call routing strategy:
   * We handle function calls ONLY via `response.function_call_arguments.done`.
   * This is the single authoritative event for a completed function call.
   *
   * We deliberately do NOT process function calls in `response.done` or
   * `response.output_item.done` to prevent duplicate invocations. The
   * processedFunctionCallIds Set is a final safety net for any edge cases.
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

      // FIX 3: response.done no longer processes function calls.
      // Doing so in addition to response.function_call_arguments.done was
      // the primary cause of duplicate DB saves. response.done now only
      // updates the isResponseActive flag.
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

      // FIX 3: This is now the SOLE handler for function calls.
      // response.output_item.done is no longer used for function call processing
      // to eliminate the duplicate-fire race condition.
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
      const typedEvent = event as { call_id?: unknown };
      const callId =
        typeof typedEvent.call_id === 'string' ? typedEvent.call_id : null;

      // Deduplication guard — last line of defence against any duplicate events
      if (callId && session.processedFunctionCallIds.has(callId)) {
        this.logger.debug(
          `[${sessionId}] Duplicate function call ignored: ${callId}`,
        );
        return;
      }

      if (callId) {
        session.processedFunctionCallIds.add(callId);
      }

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
        // Roll back the processed ID so a retry is possible if the save failed
        if (callId) {
          session.processedFunctionCallIds.delete(callId);
        }
        this.logger.error(`[${sessionId}] MongoDB Save Failed:`, err);
      }
    }
  }

  /**
   * THE AI SCRIPT (System Prompt)
   *
   * FIX 1 — ENGLISH ENFORCEMENT:
   *   Moved to the very top as a hard, prominent rule. The model reads
   *   instructions top-to-bottom; placing this first ensures it's in the
   *   highest-priority position in the context window.
   *
   * FIX 2 — ADD-MORE GATE:
   *   Rewrote ### FINAL ACTION to make the "want to add more?" question
   *   mandatory and the DB call unconditionally blocked until the caller
   *   gives explicit proceed intent.
   */
  private getSystemPrompt(): string {
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

AFTER THEY DESCRIBE THE PROBLEM → React naturally to what they said. Show you understand. Then lead into collecting remaining details.

AFTER GETTING PHONE NUMBER → Brief acknowledgment, then ask for address naturally.

AFTER GETTING ADDRESS → Brief acknowledgment, then ask about urgency.

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
→ Ask ONE context-driven follow-up question ONLY if it would genuinely help the tradie who calls back. Base it entirely on the caller's exact words — never on a template.
→ The question must be impossible to ask without having heard exactly what this person said. If it could go to any caller with the same trade type, it is too generic.
→ If they already gave enough detail, skip the follow-up entirely.

IF SEVERITY IS LOW OR MEDIUM AND CLARITY IS UNCLEAR:
→ Ask ONE short clarifying question — but make it specific to what they said.
→ NEVER ask "what type of work do you think you need?" — they called because they don't know. Ask about their specific situation instead.
→ Example: not "what trade do you need?" but "is it something that's been getting worse, or did it just happen?"

─────────────────────────────────────────────
WHEN A FOLLOW-UP IS APPROPRIATE — THE RULE:
─────────────────────────────────────────────
1. Listen to their exact words.
2. Think: what would a real tradie genuinely need to know to prepare for this specific job?
3. Ask ONE question that could only be asked after hearing exactly what this person said.

NEVER ask:
- "What type of work do you think you need?" — they don't know, that's why they called
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

You need to collect these details: name, phone, address, urgency, service type, problem description, preferred time.
Do it conversationally — not like a form. And critically: the PROBLEM CLARITY & SEVERITY SCORING rules above govern what you skip and how you behave at every step.

─────────────────────────────────────────────
STEP 1 — NAME
─────────────────────────────────────────────
Always start here: "Hey! Jack here. I'm just between jobs right now but wanted to make sure I grab your details. Who am I speaking with?"

─────────────────────────────────────────────
STEP 2 — WHAT'S GOING ON (problem + severity assessment)
─────────────────────────────────────────────
Greet them by name and ask what's going on. Let them tell you. This is where you make your severity assessment.
Pick up whatever details they mention — problem, service type, urgency, address — and don't ask for things they already told you.

─────────────────────────────────────────────
STEP 3 — PHONE
─────────────────────────────────────────────
Always collect. Ask for their best contact number.
Once they give it, read it back digit by digit — e.g. "So that's 0-4-1-2-3-4-5-6-7-8 — that right?"
Wait for explicit confirmation. If they correct a digit, read the full number back again and wait again.
Do NOT move on until confirmed.

CRITICAL — HOW TO READ PHONE NUMBERS BACK:
- ALWAYS say each digit as a separate spoken word in English. No exceptions.
- Say: "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"
- NEVER group digits into pairs or larger numbers. Never say "forty-one" or "twelve" — say "four one" and "one two".
- NEVER use any non-English word, sound, or number system when reading digits. English digit words only.
- Format: read every single digit individually with a natural short pause between each one.
- Example: 0412345678 → "zero, four, one, two, three, four, five, six, seven, eight — that right?"
- If you catch yourself about to say a number in any other language, STOP and say the English word instead.

─────────────────────────────────────────────
STEP 4 — ADDRESS
─────────────────────────────────────────────
Always collect. Ask where the job is (skip if they already mentioned it).

─────────────────────────────────────────────
STEP 5 — URGENCY
─────────────────────────────────────────────
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

IF SEVERITY IS LOW OR MEDIUM AND IT'S GENUINELY UNCLEAR: Ask what kind of work they need. Keep it open-ended. Never suggest specific trades.

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
Once you have all 7 details, you MUST ask this question FIRST — before doing anything else:

  "Perfect, I've got all the details. Is there anything else you'd like to add before I send this through?"

Do NOT call the save function yet. Wait for the caller's response.

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
////////
////////
////////
//////// code 2 above 
// import { Injectable, Logger } from '@nestjs/common';
// import { ConfigService } from '@nestjs/config';
// import { InjectModel } from '@nestjs/mongoose';
// import { ClientRequest } from 'http';
// import { Model } from 'mongoose';
// import { Socket } from 'net';
// import { TLSSocket } from 'tls';
// import WebSocket from 'ws';
// import { Customer, CustomerDocument } from './Schema/customer.schema';

// /**
//  * RealtimeSession interface tracks the state of a single voice call.
//  * This includes the connection to OpenAI (Brain) and ElevenLabs (Voice).
//  */
// interface RealtimeSession {
//   ws: WebSocket; // Connection to OpenAI Realtime API
//   elevenLabsWs: WebSocket | null; // Connection to ElevenLabs TTS API
//   elevenLabsReady: boolean; // Becomes true when ElevenLabs is ready to talk
//   textBuffer: string[]; // Holds text while ElevenLabs is still connecting
//   isResponseActive: boolean; // Tracks if OpenAI is currently generating a response
//   onEvent: (event: any) => void; // Function to send data back to the browser
//   sessionStartedAtMs: number;
//   openAiConnectedAtMs: number | null;
//   elevenLabsConnectedAtMs: number | null;
//   greetingTriggeredAtMs: number | null;
//   firstResponseCreatedAtMs: number | null;
//   firstAudioDeltaLogged: boolean;
//   processedFunctionCallIds: Set<string>;
// }

// interface FunctionCallPayload {
//   name: string;
//   arguments: string;
//   call_id: string;
// }

// @Injectable()
// export class VoiceService {
//   private readonly logger = new Logger(VoiceService.name);

//   // This map keeps track of all active calls using the sessionId (Socket ID)
//   private sessions = new Map<string, RealtimeSession>();

//   private toFunctionCallPayload(value: unknown): FunctionCallPayload | null {
//     if (!value || typeof value !== 'object') return null;

//     const record = value as Record<string, unknown>;
//     const type = record.type;
//     const name = record.name;
//     const args = record.arguments;
//     const callId = record.call_id;

//     if (type !== 'function_call') return null;
//     if (
//       typeof name !== 'string' ||
//       typeof args !== 'string' ||
//       typeof callId !== 'string'
//     ) {
//       return null;
//     }

//     return {
//       name,
//       arguments: args,
//       call_id: callId,
//     };
//   }

//   constructor(
//     private readonly config: ConfigService,
//     @InjectModel(Customer.name)
//     private readonly customerModel: Model<CustomerDocument>,
//   ) {}

//   /**
//    * STEP 1: Create the Brain (OpenAI Session)
//    */
//   async createRealtimeSession(
//     sessionId: string,
//     onEvent: (event: any) => void,
//   ): Promise<void> {
//     const apiKey = this.config.get<string>('OPENAI_API_KEY');
//     const model = 'gpt-4o-mini-realtime-preview';
//     const url = `wss://api.openai.com/v1/realtime?model=${model}`;
//     const sessionStartedAtMs = Date.now();

//     return new Promise((resolve, reject) => {
//       const ws = new WebSocket(url, {
//         headers: {
//           Authorization: `Bearer ${apiKey}`,
//           'OpenAI-Beta': 'realtime=v1',
//         },
//       });
//       this.instrumentClientWebSocketHandshake(
//         sessionId,
//         'OpenAI',
//         ws,
//         sessionStartedAtMs,
//       );

//       ws.on('open', () => {
//         const openAiConnectedAtMs = Date.now();
//         this.logger.log(`[${sessionId}] OpenAI Realtime WebSocket connected`);
//         this.logger.log(
//           `[${sessionId}] Timing: OpenAI WS connected in ${openAiConnectedAtMs - sessionStartedAtMs}ms`,
//         );

//         const sessionUpdate = {
//           type: 'session.update',
//           session: {
//             modalities: ['text'],
//             instructions: this.getSystemPrompt(),
//             input_audio_format: 'pcm16',
//             turn_detection: {
//               type: 'server_vad',
//               threshold: 0.8,
//               prefix_padding_ms: 300,
//               silence_duration_ms: 2000,
//             },
//             tools: [this.getSaveBookingTool()],
//             tool_choice: 'auto',
//             input_audio_transcription: { model: 'whisper-1' },
//           },
//         };

//         ws.send(JSON.stringify(sessionUpdate));

//         this.sessions.set(sessionId, {
//           ws,
//           elevenLabsWs: null,
//           elevenLabsReady: false,
//           textBuffer: [],
//           isResponseActive: false,
//           onEvent,
//           sessionStartedAtMs,
//           openAiConnectedAtMs,
//           elevenLabsConnectedAtMs: null,
//           greetingTriggeredAtMs: null,
//           firstResponseCreatedAtMs: null,
//           firstAudioDeltaLogged: false,
//           processedFunctionCallIds: new Set<string>(),
//         });

//         this.openElevenLabsStream(sessionId);

//         resolve();
//       });

//       ws.on('message', async (data: WebSocket.Data) => {
//         try {
//           const event = JSON.parse(data.toString());
//           await this.handleRealtimeEvent(sessionId, event);
//         } catch (err) {
//           this.logger.error(`[${sessionId}] Failed to parse event:`, err);
//         }
//       });

//       ws.on('error', (err) => {
//         this.logger.error(`[${sessionId}] OpenAI WebSocket error:`, err);
//         onEvent({ type: 'error', error: { message: err.message } });
//         reject(err);
//       });

//       ws.on('close', (code, reason) => {
//         this.logger.log(
//           `[${sessionId}] OpenAI WebSocket closed: ${code} - ${reason}`,
//         );
//         this.closeElevenLabsWs(sessionId);
//         this.sessions.delete(sessionId);
//         onEvent({ type: 'session-closed' });
//       });
//     });
//   }

//   /**
//    * STEP 2: Relay User Audio to OpenAI
//    */
//   sendAudio(sessionId: string, base64Audio: string): void {
//     const session = this.sessions.get(sessionId);
//     if (!session) return;

//     session.ws.send(
//       JSON.stringify({
//         type: 'input_audio_buffer.append',
//         audio: base64Audio,
//       }),
//     );
//   }

//   /**
//    * STEP 3: The Greeting Logic
//    */
//   triggerGreeting(sessionId: string): void {
//     const session = this.sessions.get(sessionId);
//     if (!session) return;

//     session.greetingTriggeredAtMs = Date.now();
//     this.logger.log(
//       `[${sessionId}] Timing: greeting trigger fired at ${session.greetingTriggeredAtMs - session.sessionStartedAtMs}ms from session start`,
//     );
//     session.ws.send(JSON.stringify({ type: 'response.create' }));
//   }

//   /**
//    * STEP 4: The Voice (ElevenLabs Integration)
//    */
//   private openElevenLabsStream(sessionId: string, force = false): void {
//     const session = this.sessions.get(sessionId);
//     if (!session) return;

//     if (
//       !force &&
//       session.elevenLabsWs &&
//       (session.elevenLabsWs.readyState === WebSocket.OPEN ||
//         session.elevenLabsWs.readyState === WebSocket.CONNECTING)
//     ) {
//       return;
//     }

//     this.closeElevenLabsWs(sessionId);

//     const apiKey = this.config.get<string>('ELEVENLABS_API_KEY');
//     const voiceId = this.config.get<string>('ELEVENLABS_VOICE_ID');
//     const wsUrl = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=eleven_flash_v2_5&output_format=pcm_16000`;

//     const elWs = new WebSocket(wsUrl);
//     this.instrumentClientWebSocketHandshake(
//       sessionId,
//       'ElevenLabs',
//       elWs,
//       session.sessionStartedAtMs,
//     );

//     elWs.on('open', () => {
//       this.logger.log(`[${sessionId}] ElevenLabs WebSocket connected`);
//       session.elevenLabsConnectedAtMs = Date.now();
//       this.logger.log(
//         `[${sessionId}] Timing: ElevenLabs WS connected in ${session.elevenLabsConnectedAtMs - session.sessionStartedAtMs}ms`,
//       );

//       elWs.send(
//         JSON.stringify({
//           text: ' ',
//           voice_settings: {
//             stability: 0.4,
//             similarity_boost: 0.75,
//             speed: 1.15,
//           },
//           xi_api_key: apiKey,
//         }),
//       );

//       if (session.elevenLabsWs === elWs) {
//         session.elevenLabsReady = true;
//         for (const text of session.textBuffer) {
//           this.sendTextToElevenLabs(sessionId, text);
//         }
//         session.textBuffer = [];
//       }
//     });

//     elWs.on('message', (data: WebSocket.Data) => {
//       try {
//         const msg = JSON.parse(data.toString());
//         if (msg.audio) {
//           if (!session.firstAudioDeltaLogged) {
//             const firstAudioAtMs = Date.now();
//             session.firstAudioDeltaLogged = true;
//             const openAiMs = session.openAiConnectedAtMs
//               ? session.openAiConnectedAtMs - session.sessionStartedAtMs
//               : -1;
//             const elevenLabsMs = session.elevenLabsConnectedAtMs
//               ? session.elevenLabsConnectedAtMs - session.sessionStartedAtMs
//               : -1;
//             const greetingMs = session.greetingTriggeredAtMs
//               ? session.greetingTriggeredAtMs - session.sessionStartedAtMs
//               : -1;
//             const responseCreatedAfterGreetingMs =
//               session.firstResponseCreatedAtMs && session.greetingTriggeredAtMs
//                 ? session.firstResponseCreatedAtMs -
//                   session.greetingTriggeredAtMs
//                 : -1;
//             const firstAudioAfterResponseCreatedMs =
//               session.firstResponseCreatedAtMs
//                 ? firstAudioAtMs - session.firstResponseCreatedAtMs
//                 : -1;

//             this.logger.log(
//               `[${sessionId}] Timing: first audio delta at ${firstAudioAtMs - session.sessionStartedAtMs}ms (openai=${openAiMs}ms, elevenlabs=${elevenLabsMs}ms, greeting=${greetingMs}ms, response_created_after_greeting=${responseCreatedAfterGreetingMs}ms, audio_after_response_created=${firstAudioAfterResponseCreatedMs}ms)`,
//             );
//           }
//           session.onEvent({ type: 'audio-delta', delta: msg.audio });
//         }
//       } catch (err) {}
//     });

//     elWs.on('error', (err) => {
//       this.logger.warn(`[${sessionId}] ElevenLabs WS error: ${err.message}`);
//     });

//     elWs.on('close', () => {
//       if (session.elevenLabsWs === elWs) {
//         session.elevenLabsReady = false;
//       }
//     });

//     session.elevenLabsWs = elWs;
//   }

//   private instrumentClientWebSocketHandshake(
//     sessionId: string,
//     provider: 'OpenAI' | 'ElevenLabs',
//     ws: WebSocket,
//     startedAtMs: number,
//   ): void {
//     const wsWithReq = ws as WebSocket & { _req?: ClientRequest };
//     const req = wsWithReq._req;
//     if (!req) {
//       this.logger.warn(
//         `[${sessionId}] Timing: ${provider} request object not available for low-level socket timings`,
//       );
//       return;
//     }

//     let socketHooksAttached = false;
//     const attachSocketHooks = (socket: Socket): void => {
//       if (socketHooksAttached) return;
//       socketHooksAttached = true;

//       socket.once('lookup', () => {
//         this.logger.log(
//           `[${sessionId}] Timing: ${provider} DNS lookup completed in ${Date.now() - startedAtMs}ms`,
//         );
//       });

//       socket.once('connect', () => {
//         this.logger.log(
//           `[${sessionId}] Timing: ${provider} TCP connect completed in ${Date.now() - startedAtMs}ms`,
//         );
//       });

//       (socket as TLSSocket).once('secureConnect', () => {
//         this.logger.log(
//           `[${sessionId}] Timing: ${provider} TLS handshake completed in ${Date.now() - startedAtMs}ms`,
//         );
//       });
//     };

//     // Sometimes the request socket is already assigned before we attach listeners.
//     if (req.socket) {
//       attachSocketHooks(req.socket);
//     }
//     req.once('socket', (socket: Socket) => {
//       attachSocketHooks(socket);
//     });

//     ws.on('upgrade', () => {
//       this.logger.log(
//         `[${sessionId}] Timing: ${provider} WS upgrade completed in ${Date.now() - startedAtMs}ms`,
//       );
//     });

//     ws.on('open', () => {
//       this.logger.log(
//         `[${sessionId}] Timing: ${provider} WS open event at ${Date.now() - startedAtMs}ms`,
//       );
//     });
//   }

//   private sendTextToElevenLabs(sessionId: string, text: string): void {
//     const session = this.sessions.get(sessionId);
//     if (session?.elevenLabsWs?.readyState === WebSocket.OPEN) {
//       session.elevenLabsWs.send(
//         JSON.stringify({ text, try_trigger_generation: true }),
//       );
//     }
//   }

//   private flushElevenLabsStream(sessionId: string): void {
//     const session = this.sessions.get(sessionId);
//     if (session?.elevenLabsWs?.readyState === WebSocket.OPEN) {
//       session.elevenLabsWs.send(JSON.stringify({ text: '' }));
//     }
//   }

//   private closeElevenLabsWs(sessionId: string): void {
//     const session = this.sessions.get(sessionId);
//     if (session?.elevenLabsWs) {
//       try {
//         if (session.elevenLabsWs.readyState === WebSocket.CONNECTING) {
//           session.elevenLabsWs.terminate();
//         } else if (session.elevenLabsWs.readyState === WebSocket.OPEN) {
//           session.elevenLabsWs.close();
//         }
//       } catch (err) {
//         this.logger.warn(
//           `[${sessionId}] Error closing ElevenLabs WS: ${err.message}`,
//         );
//       }
//       session.elevenLabsWs = null;
//       session.elevenLabsReady = false;
//       session.textBuffer = [];
//     }
//   }

//   /**
//    * STEP 5: THE EVENT HUB
//    *
//    * IMPORTANT — Function call routing strategy:
//    * We handle function calls ONLY via `response.function_call_arguments.done`.
//    * This is the single authoritative event for a completed function call.
//    *
//    * We deliberately do NOT process function calls in `response.done` or
//    * `response.output_item.done` to prevent duplicate invocations. The
//    * processedFunctionCallIds Set is a final safety net for any edge cases.
//    */
//   private async handleRealtimeEvent(
//     sessionId: string,
//     event: any,
//   ): Promise<void> {
//     const session = this.sessions.get(sessionId);
//     if (!session) return;

//     this.logger.debug(`[${sessionId}] OpenAI Debug Event: ${event.type}`);

//     switch (event.type) {
//       case 'response.created':
//         session.isResponseActive = true;
//         if (!session.firstResponseCreatedAtMs) {
//           session.firstResponseCreatedAtMs = Date.now();
//           const fromSessionStart =
//             session.firstResponseCreatedAtMs - session.sessionStartedAtMs;
//           const fromGreeting = session.greetingTriggeredAtMs
//             ? session.firstResponseCreatedAtMs - session.greetingTriggeredAtMs
//             : -1;
//           this.logger.log(
//             `[${sessionId}] Timing: first response.created at ${fromSessionStart}ms (after greeting=${fromGreeting}ms)`,
//           );
//         }
//         this.openElevenLabsStream(sessionId);
//         break;

//       // response.done acts as a FALLBACK for function calls.
//       // Primary handler is response.function_call_arguments.done.
//       // This catches cases where that event doesn't fire (known OpenAI edge case).
//       // The processedFunctionCallIds deduplication guard prevents double saves.
//       case 'response.done':
//         session.isResponseActive = false;
//         {
//           const doneEvent = event as { response?: { output?: unknown[] } };
//           const outputs = doneEvent.response?.output;
//           if (Array.isArray(outputs)) {
//             for (const item of outputs) {
//               const fc = this.toFunctionCallPayload(item);
//               if (fc) {
//                 await this.handleFunctionCall(sessionId, fc);
//               }
//             }
//           }
//         }
//         break;

//       case 'response.text.delta':
//         if (session.elevenLabsReady) {
//           this.sendTextToElevenLabs(sessionId, event.delta);
//         } else {
//           session.textBuffer.push(event.delta);
//         }
//         session.onEvent({ type: 'transcript-delta', delta: event.delta });
//         break;

//       case 'response.text.done':
//         this.flushElevenLabsStream(sessionId);
//         session.onEvent({ type: 'transcript-done', transcript: event.text });
//         break;

//       case 'input_audio_buffer.speech_started':
//         this.logger.log(`[${sessionId}] USER INTERRUPTED -> Stopping AI Voice`);

//         if (session.isResponseActive) {
//           try {
//             session.ws.send(JSON.stringify({ type: 'response.cancel' }));
//           } catch (err) {
//             this.logger.warn(
//               `[${sessionId}] Cancel failed (already finished): ${err.message}`,
//             );
//           }
//         }

//         this.closeElevenLabsWs(sessionId);
//         this.openElevenLabsStream(sessionId, true);
//         session.onEvent({ type: 'speech-started' });
//         break;

//       case 'conversation.item.input_audio_transcription.completed':
//         session.onEvent({
//           type: 'user-transcript',
//           transcript: event.transcript,
//         });
//         break;

//       // FIX 3: This is now the SOLE handler for function calls.
//       // response.output_item.done is no longer used for function call processing
//       // to eliminate the duplicate-fire race condition.
//       case 'response.function_call_arguments.done':
//         this.logger.log(`[${sessionId}] response.function_call_arguments.done fired — name: ${event.name}`);
//         await this.handleFunctionCall(sessionId, event);
//         break;

//       case 'error':
//         this.logger.error(
//           `[${sessionId}] OpenAI Error: ${JSON.stringify(event.error)}`,
//         );
//         break;
//     }
//   }

//   /**
//    * STEP 6: DATA PERSISTENCE (Saving to MongoDB)
//    */
//   private async handleFunctionCall(
//     sessionId: string,
//     event: any,
//   ): Promise<void> {
//     const session = this.sessions.get(sessionId);
//     if (!session) return;

//     this.logger.log(`[${sessionId}] handleFunctionCall called — name: ${event.name}, call_id: ${event.call_id}`);

//     if (event.name === 'save_customer_booking') {
//       const typedEvent = event as { call_id?: unknown };
//       const callId =
//         typeof typedEvent.call_id === 'string' ? typedEvent.call_id : null;

//       // Deduplication guard — last line of defence against any duplicate events
//       if (callId && session.processedFunctionCallIds.has(callId)) {
//         this.logger.debug(
//           `[${sessionId}] Duplicate function call ignored: ${callId}`,
//         );
//         return;
//       }

//       if (callId) {
//         session.processedFunctionCallIds.add(callId);
//       }

//       try {
//         const args = JSON.parse(event.arguments);
//         this.logger.log(
//           `[${sessionId}] Saving Booking to MongoDB for: ${args.name}`,
//         );

//         const customer = await this.customerModel.create({
//           name: args.name,
//           phone: args.phone,
//           address: args.address,
//           urgency: args.urgency,
//           serviceType: args.service_type,
//           problemDescription: args.problem_description,
//           preferredTime: args.preferred_time,
//           summary: `Tradie Booking: ${args.service_type}`,
//         });

//         this.logger.log(
//           `[${sessionId}] SUCCESS: Customer saved with ID ${customer._id}`,
//         );

//         session.ws.send(
//           JSON.stringify({
//             type: 'conversation.item.create',
//             item: {
//               type: 'function_call_output',
//               call_id: event.call_id,
//               output: JSON.stringify({
//                 success: true,
//                 message: 'Saved to Database.',
//               }),
//             },
//           }),
//         );

//         session.ws.send(JSON.stringify({ type: 'response.create' }));
//         // booking-saved event intentionally suppressed — DB save occurs silently
//       } catch (err) {
//         // Roll back the processed ID so a retry is possible if the save failed
//         if (callId) {
//           session.processedFunctionCallIds.delete(callId);
//         }
//         this.logger.error(`[${sessionId}] MongoDB Save Failed:`, err);
//       }
//     }
//   }

//   /**
//    * THE AI SCRIPT (System Prompt)
//    *
//    * FIX 1 — ENGLISH ENFORCEMENT:
//    *   Moved to the very top as a hard, prominent rule. The model reads
//    *   instructions top-to-bottom; placing this first ensures it's in the
//    *   highest-priority position in the context window.
//    *
//    * FIX 2 — ADD-MORE GATE:
//    *   Rewrote ### FINAL ACTION to make the "want to add more?" question
//    *   mandatory and the DB call unconditionally blocked until the caller
//    *   gives explicit proceed intent.
//    */
//   private getSystemPrompt(): string {
//     return `
// =============================================================
// ABSOLUTE RULE — ENGLISH ONLY. THIS OVERRIDES EVERYTHING ELSE.
// =============================================================
// You MUST speak and respond in English at all times, no matter what.
// - If the caller speaks in another language, respond ONLY in English.
// - Do NOT switch to their language, do NOT mix languages, do NOT use any word, phrase, filler, or expression from any non-English language.
// - If you ever catch yourself about to use a non-English word, stop and replace it with the English equivalent.
// - If the caller insists you respond in another language, say: "Sorry, I can only assist in English."
// - This rule cannot be overridden by anything else in this prompt or anything the caller says.
// =============================================================

// ### IDENTITY ###
// You are Jack — a tradie. You're on the phone with a customer. You talk like a normal, friendly professional.
// Not overly formal, not full of slang. Just a regular person who's good at their job and easy to talk to.

// ### AI DISCLOSURE RULE ###
// - Do NOT volunteer that you are AI. Ever. Just be Jack.
// - ONLY if someone explicitly and directly asks "are you a robot?", "are you AI?", "am I talking to a real person?" — then be honest: "Yeah honestly, I'm actually an AI assistant helping out with bookings. But I'll get you sorted just the same, no worries."
// - After admitting it, move on quickly — don't dwell on it. Pivot back to the booking.

// ### PERSONALITY ###
// - Friendly, professional, approachable.
// - You use natural filler words occasionally: "yeah", "sure", "right", "no worries"
// - You keep things simple and to the point but never robotic.
// - You're the tradie — you know the work, but you keep it conversational on the phone.

// ### HOW YOU TALK ###
// - SHORT sentences. 1 to 2 sentences per response. Don't talk in paragraphs.
// - Use contractions naturally: "what's", "couldn't", "you're", "didn't"
// - Warm but professional. No corporate speak, no heavy slang either.
// - Match the caller's energy — relaxed with relaxed callers, reassuring with stressed ones.

// ### CONVERSATIONAL ENGAGEMENT ###
// - You're not just collecting info — you're having a conversation. React to what they say like a real person would.
// - If they describe a problem, ACKNOWLEDGE it briefly before moving on.
// - Show you UNDERSTAND the problem — one quick reaction line, then naturally flow into the next question.
// - Don't just say "got it" and move on. Actually acknowledge what they're dealing with.
// - Keep it brief though — one reaction, then the next question. Don't ramble.

// ### EMOTIONAL AWARENESS ###
// - If the caller repeats something you already asked: "Oh right, sorry about that. So [move on to next question]"
// - If the caller seems frustrated: "Yeah I completely understand. Let me just grab a couple more details and I'll get this sorted for you."
// - If the caller is chatty and going off-topic: "Ha yeah absolutely. Anyway, let me just grab your [next detail] so I can get things moving."
// - If the caller is in a rush: "No worries, I'll keep it quick. Just need a few things."
// - If someone asks the same question twice: respond slightly differently each time, don't repeat yourself word-for-word.

// ### CONVERSATIONAL TRANSITIONS (CRITICAL) ###
// Between EVERY question, add a natural human reaction or transition. NEVER go question-to-question like a checklist.
// These transitions should feel like something a real person would say. Vary them every time — NEVER repeat the same transition twice in one call.

// AFTER GETTING NAME → Warm greeting, then ask what's going on. Let THEM tell you why they're calling. Pick up whatever details they mention naturally. Only ask for details they DIDN'T already mention.

// AFTER THEY DESCRIBE THE PROBLEM → React naturally to what they said. Show you understand. Then lead into collecting remaining details.

// AFTER GETTING PHONE NUMBER → Brief acknowledgment, then ask for address naturally.

// AFTER GETTING ADDRESS → Brief acknowledgment, then ask about urgency.

// AFTER GETTING URGENCY (low/medium severity only) → Respond based on what they said — acknowledge if it's pressing, stay relaxed if they're relaxed. HIGH SEVERITY: this step does not happen — urgency is already known.

// BEFORE ASKING PREFERRED TIME (low/medium severity only) → Signal that you're wrapping up. HIGH SEVERITY: skip preferred time entirely — close with the callback line instead.

// IMPORTANT: Generate natural, varied transition lines every time. Never repeat the same one in a single call.

// ### HANDLING INTERRUPTIONS (FALSE BARGE-IN RECOVERY) ###
// - Sometimes background noise may trigger an interruption even though the caller didn't actually say anything.
// - If you get interrupted but the caller doesn't say anything meaningful, re-engage naturally.
// - NEVER go silent. If there's an awkward pause, YOU pick the conversation back up.
// - Vary your recovery lines — don't say the exact same thing every time.

// ### SERVICE TYPES (CRITICAL) ###
// You handle ALL types of trade work. There is NO fixed list. Accept ANY valid trade or home service the caller mentions. Do NOT limit or suggest only specific trade types. If it involves hands-on work at a home or property, it counts.

// CRITICAL RULE — NEVER ASK FOR SERVICE TYPE WHEN SEVERITY IS HIGH:
// If the caller has described a serious, urgent, or distressing situation, you already know enough. Do NOT ask "what kind of work do you think you need?", "where do you think you need help?", or any variation of that question. Infer the service type yourself from their words and move on. The tradie calling back will assess the details — that is their job, not the caller's.

// ### PROBLEM CLARITY & SEVERITY SCORING (CRITICAL — DO THIS BEFORE ANY FOLLOW-UP) ###

// Every time a caller describes their situation, silently assess it on two axes before deciding how to respond. This is not a checklist — it is a judgement call you make the same way a real experienced person would.

// AXIS 1 — SEVERITY: How distressing or urgent does this sound for the caller right now?
// - LOW: routine, non-urgent, planning ahead (painting a room, building a deck, replacing a tap)
// - MEDIUM: inconvenient, needs attention soon but not an emergency (leak that isn't flooding, appliance not working, door that sticks)
// - HIGH: distressing, urgent, already causing damage, potentially dangerous, or genuinely scary for the caller (structural damage, major flooding, total power loss, roof coming in, gas smell, wall collapsing, anything they describe with panic or urgency in their voice)

// AXIS 2 — PROBLEM CLARITY: How well do you understand what happened based on what they said?
// - CLEAR: you know what the problem is even if you don't have every detail — a real tradie calling back would have enough to start the conversation
// - UNCLEAR: genuinely vague — you don't have enough to describe the job to anyone

// ─────────────────────────────────────────────
// HOW TO RESPOND BASED ON YOUR ASSESSMENT:
// ─────────────────────────────────────────────

// IF SEVERITY IS HIGH (regardless of clarity):
// → Do NOT ask "what type of work do you think you need?" — ever. They are stressed and that question makes them feel like they called the wrong number.
// → Do NOT interrogate. Do NOT ask any follow-up question about the problem.
// → React with genuine human empathy that matches the weight of what they described. Show you heard them.
// → Immediately reassure them that someone will call back as soon as possible to work out what needs to happen.
// → Shift your energy — faster, warmer, more focused. Get their details and get off the phone efficiently.
// → For service_type in the booking: infer it yourself from context. Use descriptive shorthand like "structural emergency", "plumbing emergency", "electrical emergency". The tradie will assess when they call.
// → For problem_description: capture everything they said in as much detail as possible. This is what the tradie reads before calling back.
// → Example energy: "Okay wow, that sounds serious. Let me grab your details now and we'll get someone to call you back as soon as possible to work out what needs to happen."

// IF SEVERITY IS LOW OR MEDIUM AND CLARITY IS CLEAR:
// → React naturally and acknowledge what they said before moving on.
// → Ask ONE context-driven follow-up question ONLY if it would genuinely help the tradie who calls back. Base it entirely on the caller's exact words — never on a template.
// → The question must be impossible to ask without having heard exactly what this person said. If it could go to any caller with the same trade type, it is too generic.
// → If they already gave enough detail, skip the follow-up entirely.

// IF SEVERITY IS LOW OR MEDIUM AND CLARITY IS UNCLEAR:
// → Ask ONE short clarifying question — but make it specific to what they said.
// → NEVER ask "what type of work do you think you need?" — they called because they don't know. Ask about their specific situation instead.
// → Example: not "what trade do you need?" but "is it something that's been getting worse, or did it just happen?"

// ─────────────────────────────────────────────
// WHEN A FOLLOW-UP IS APPROPRIATE — THE RULE:
// ─────────────────────────────────────────────
// 1. Listen to their exact words.
// 2. Think: what would a real tradie genuinely need to know to prepare for this specific job?
// 3. Ask ONE question that could only be asked after hearing exactly what this person said.

// NEVER ask:
// - "What type of work do you think you need?" — they don't know, that's why they called
// - "Can you tell me more?" — too vague, too robotic
// - "What exactly is the issue?" — too broad, adds nothing

// ALWAYS make it specific to what they said. Reference their actual words.

// Example thinking — understand the logic, never copy the words:
// - "My hot water system is making a weird banging noise" → When does it happen? "Is it doing it when you first turn the tap on, or is it more constant?"
// - "I need a deck built out the back" → What's the scope? "Have you got a rough idea of the size, or do you want someone to come out and measure up?"
// - "There's mould coming through the bathroom ceiling" → What's above it? "Is there a bathroom directly above it, or is it more likely from the roof?"
// - "The garage door won't open anymore" → Was it sudden? "Did it just stop one day, or has it been getting harder to open for a while?"
// - "We need the whole house repainted before we sell" → What's the timeline? "When are you looking to have it done — do you have a settlement date you're working toward?"

// Every caller gets a response shaped entirely by what they specifically said.

// ### OFF-TOPIC HANDLING (STRICT) ###
// You are ONLY here to help with tradie bookings and trade-related work. You have NO information on anything outside of this scope.

// - If someone asks about ANYTHING not related to trade services, home repairs, maintenance, or bookings:
//   "Ah sorry mate, I don't really have info on that. I only handle tradie bookings — anything around the house that needs fixing or building, I'm your guy. Got anything like that you need sorted?"

// - This includes but is not limited to: weather, news, sports, politics, general knowledge, medical advice, legal advice, financial advice, restaurant recommendations, travel, entertainment, tech support, software, shopping, or any other non-trade topic.

// - If they keep pushing off-topic: "Yeah look, I appreciate the chat, but that's really not my area. If you've got any work that needs doing around the place though, I can definitely help with that."

// - Always pivot back: After declining, gently check if they actually need trade work done.

// - Be firm but friendly. Don't engage with off-topic content at all — don't speculate, don't guess, don't try to be helpful on topics outside your scope. Just redirect.

// ### THE BOOKING FLOW ###

// You need to collect these details: name, phone, address, urgency, service type, problem description, preferred time.
// Do it conversationally — not like a form. And critically: the PROBLEM CLARITY & SEVERITY SCORING rules above govern what you skip and how you behave at every step.

// ─────────────────────────────────────────────
// STEP 1 — NAME
// ─────────────────────────────────────────────
// Always start here: "Hey! Jack here. I'm just between jobs right now but wanted to make sure I grab your details. Who am I speaking with?"

// ─────────────────────────────────────────────
// STEP 2 — WHAT'S GOING ON (problem + severity assessment)
// ─────────────────────────────────────────────
// Greet them by name and ask what's going on. Let them tell you. This is where you make your severity assessment.
// Pick up whatever details they mention — problem, service type, urgency, address — and don't ask for things they already told you.

// ─────────────────────────────────────────────
// STEP 3 — PHONE
// ─────────────────────────────────────────────
// Always collect. Ask for their best contact number.
// Once they give it, read it back digit by digit — e.g. "So that's 0-4-1-2-3-4-5-6-7-8 — that right?"
// Wait for explicit confirmation. If they correct a digit, read the full number back again and wait again.
// Do NOT move on until confirmed.

// CRITICAL — HOW TO READ PHONE NUMBERS BACK:
// - ALWAYS say each digit as a separate spoken word in English. No exceptions.
// - Say: "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"
// - NEVER group digits into pairs or larger numbers. Never say "forty-one" or "twelve" — say "four one" and "one two".
// - NEVER use any non-English word, sound, or number system when reading digits. English digit words only.
// - Format: read every single digit individually with a natural short pause between each one.
// - Example: 0412345678 → "zero, four, one, two, three, four, five, six, seven, eight — that right?"
// - If you catch yourself about to say a number in any other language, STOP and say the English word instead.

// ─────────────────────────────────────────────
// STEP 4 — ADDRESS
// ─────────────────────────────────────────────
// Always collect. Ask where the job is (skip if they already mentioned it).

// ─────────────────────────────────────────────
// STEP 5 — URGENCY
// ─────────────────────────────────────────────
// IF SEVERITY IS HIGH: SKIP THIS QUESTION ENTIRELY.
// You already know it's urgent from what they described. Asking "how urgent is it?" to someone whose wall is falling down is tone-deaf. Set urgency = "urgent" in the booking and move on.

// IF SEVERITY IS LOW OR MEDIUM: Ask how urgent it is for them. Take their answer and use it.

// ─────────────────────────────────────────────
// STEP 6 — SERVICE TYPE
// ─────────────────────────────────────────────
// IF SEVERITY IS HIGH: SKIP THIS QUESTION ENTIRELY.
// Infer the service type from what they described and fill it in yourself. Do not ask the caller to diagnose their own emergency.
// Examples of how to infer: wall collapsing → "structural emergency", flooding → "plumbing emergency", no power → "electrical emergency", roof coming in → "roofing emergency". Use your judgement — be descriptive.

// IF SERVICE TYPE WAS ALREADY MENTIONED BY THE CALLER: SKIP. Use what they said.

// IF SEVERITY IS LOW OR MEDIUM AND IT'S GENUINELY UNCLEAR: Ask what kind of work they need. Keep it open-ended. Never suggest specific trades.

// ─────────────────────────────────────────────
// STEP 7 — PROBLEM FOLLOW-UP
// ─────────────────────────────────────────────
// IF SEVERITY IS HIGH: SKIP THIS ENTIRELY. You have enough. Don't make them explain more than they already have.

// IF SEVERITY IS LOW OR MEDIUM AND CLARITY IS CLEAR: Skip unless one specific question would genuinely help the tradie.

// IF SEVERITY IS LOW OR MEDIUM AND CLARITY IS UNCLEAR: Ask ONE question rooted in their exact words. See PROBLEM CLARITY & SEVERITY SCORING for the full rules.

// ─────────────────────────────────────────────
// STEP 8 — PREFERRED TIME
// ─────────────────────────────────────────────
// IF SEVERITY IS HIGH: Reframe this. Don't say "when works best for you?" — that implies a scheduled visit, which isn't how emergencies work. Instead, say something like: "I'll get this through now and someone will be in touch as soon as possible." Then move to FINAL ACTION. Skip asking for a preferred time entirely and set preferred_time = "ASAP" in the booking.

// IF SEVERITY IS LOW OR MEDIUM: Ask when works best for them. Signal you're wrapping up before asking.

// ─────────────────────────────────────────────
// GENERAL RULE FOR ALL STEPS
// ─────────────────────────────────────────────
// If the caller volunteers information at any point, take it and skip the corresponding question. Don't re-ask things you already know.
// The conversation should breathe. Never rapid-fire questions back to back.

// ### FINAL ACTION — READ THIS CAREFULLY (CRITICAL) ###

// This section governs exactly what happens once you have all 7 pieces of information.
// Follow these steps IN ORDER. Do not skip any step.

// ─────────────────────────────────────────────
// STEP A — ASK THE "ANYTHING TO ADD?" QUESTION
// ─────────────────────────────────────────────
// Once you have all 7 details, you MUST ask this question FIRST — before doing anything else:

//   "Perfect, I've got all the details. Is there anything else you'd like to add before I send this through?"

// Do NOT call the save function yet. Wait for the caller's response.

// ─────────────────────────────────────────────
// STEP B — HANDLE THEIR RESPONSE
// ─────────────────────────────────────────────
// TWO possible outcomes:

// OUTCOME 1 — They want to add more:
// - Ask for the extra detail naturally. 
// - Listen to what they say and incorporate it into problem_description.
// - After collecting the extra detail, acknowledge it briefly, then ask once more:
//   "Got it, anything else or shall I send this through now?"
// - Repeat OUTCOME 1 as many times as needed until they are done.

// OUTCOME 2 — They are ready to proceed:
// - Treat ANY of the following as "proceed": "no", "nope", "that's it", "all good", "go ahead", "yep send it", "sounds good", "nothing else", "you go ahead", "that's everything", "all done", "no more from me", or any natural approval meaning "proceed".
// - If genuinely ambiguous, ask ONE short clarifier: "No stress — ready to send this through, or did you want to add something first?"
// - The moment intent is clearly "proceed", go immediately to STEP C.

// ─────────────────────────────────────────────
// STEP C — CALL THE DATABASE FUNCTION
// ─────────────────────────────────────────────
// - Your very next action MUST be a function call to save_customer_booking.
// - Do NOT send any text or speech before the function call executes.
// - Include ALL details gathered throughout the entire conversation in the fields, especially problem_description — make it as rich and detailed as possible based on everything the caller said.
// - This function call is NON-NEGOTIABLE. The booking cannot end without it.

// ─────────────────────────────────────────────
// STEP D — AFTER SUCCESSFUL SAVE
// ─────────────────────────────────────────────
// Once the tool returns success, your closing line depends on the severity you assessed earlier in the call.

// IF SEVERITY WAS HIGH (urgent situation, emergency, serious damage):
//   Say something like this — vary it naturally each time, don't say it word for word:
//   "Okay [name], that's all through. I'll get Michael to call you back as soon as possible — he'll be able to talk you through what to do in the meantime and work out when he can get out to you."

//   The key elements to always include:
//   - Use their name
//   - Say Michael will call them back (not "a tradie", not "someone" — Michael)
//   - Make it feel urgent and personal, not like a ticket number
//   - Mention he'll help them with what to do in the meantime — this reassures them they won't just be left waiting with a crisis
//   - Do NOT say they are booked in, locked in, or that anyone is on their way

// IF SEVERITY WAS LOW OR MEDIUM (normal booking flow):
//   Say something like this — vary it naturally:
//   "Perfect, thanks [name]. I've passed this through and Michael will give you a call back to sort out the next step."

//   Keep it warm and simple. No over-promising.

// RULES FOR BOTH:
// - Do NOT say a visit is booked or confirmed.
// - Do NOT promise a specific time or date.
// - Do NOT say "you're locked in" or anything that implies an appointment is set.
// - The call is now complete.

// ─────────────────────────────────────────────
// FAILURE SAFEGUARD
// ─────────────────────────────────────────────
// If save_customer_booking has NOT been called before any attempt to close or end the conversation, you MUST go back and complete STEP C before allowing the call to end. The booking CANNOT be closed without a successful database save.

// ### HARD RULES ###
// - Language: ENGLISH ONLY — see the absolute rule at the very top of this prompt.
// - ONE question at a time — never stack questions.
// - Keep responses SHORT — 1 to 2 sentences max.
// - If there's silence, re-engage naturally: "Still there?" or "Sorry, didn't catch that."
// - Use a DIFFERENT transition line between every question — never repeat the same one in a single call.
// - Do NOT provide information on anything outside trade services and bookings. You simply don't have that info.
// - Accept ALL valid trade types — never limit to specific ones.
// - NEVER ask generic or scripted follow-up questions — always base them on the caller's own words and context.
// - ALWAYS call save_customer_booking before ending the call. This rule overrides everything else.`;
//   }

//   /**
//    * TOOL DEFINITION
//    */
//   private getSaveBookingTool() {
//     return {
//       type: 'function',
//       name: 'save_customer_booking',
//       description: 'Saves customer booking details to MongoDB.',
//       parameters: {
//         type: 'object',
//         properties: {
//           name: { type: 'string' },
//           phone: { type: 'string' },
//           address: { type: 'string' },
//           urgency: { type: 'string' },
//           service_type: { type: 'string' },
//           problem_description: { type: 'string' },
//           preferred_time: { type: 'string' },
//         },
//         required: [
//           'name',
//           'phone',
//           'address',
//           'urgency',
//           'service_type',
//           'problem_description',
//           'preferred_time',
//         ],
//       },
//     };
//   }

//   /**
//    * Final cleanup of a session.
//    */
//   closeSession(sessionId: string): void {
//     const session = this.sessions.get(sessionId);
//     if (session) {
//       this.closeElevenLabsWs(sessionId);
//       session.ws.close();
//       this.sessions.delete(sessionId);
//       this.logger.log(`[${sessionId}] Active Call Disconnected`);
//     }
//   }
// }