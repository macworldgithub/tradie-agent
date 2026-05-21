# System Flow Documentation

## Onboarding Flow

1. Company calls POST /api/auth/register with: customerName, companyName, email, password, trade, mobileNumber
2. On success, company receives JWT token.
3. Company calls POST /tradies with: name, phoneNumber, email, notificationPreference.
   - Note: Authorization: Bearer <token> header is required. companyId is automatically read from the JWT.
4. On success, tradieId is returned.
5. Company calls GET /tradies/mine to get a list of their tradies for the DID assignment dropdown.
6. Company calls POST /dids with: didNumber, assignedTradieId, tradieNumber (optional).
   - Note: Authorization: Bearer <token> header is required. companyId is automatically read from the JWT.
7. On success, DID is mapped and ready to receive calls.
8. Company configures their Enfonica DID webhook to: https://tradie.omnisuiteai.com/webhook/call
9. System is live — any call to the DID will route to the tradie

## webhook/

### Purpose

This module is the external entry point for Enfonica webhooks and controls the first call leg (dial tradie) plus callback leg (complete vs fallback to Asterisk SIP).

### Files

- `webhook.module.ts` → wires `WebhookController` and `WebhookService`, and imports `DidsModule`, `TradiesModule`, `CallsModule`, and `AriModule`.
- `webhook.controller.ts` → exposes `POST /webhook/call`, reads request body and optional `enfonicaCallId` query param, returns XML responses.
- `webhook.service.ts` → implements inbound/callback routing logic, DID + tradie lookup, call logging, status updates, and fallback VoiceML.
- `dtos/webhook-call.dto.ts` → defines webhook payload fields: `name`, `from`, `to`, `callStatus`.

### Flow

1. Enfonica sends `POST /webhook/call`.
2. Controller forwards body plus `req.query.enfonicaCallId` into `WebhookService.handleIncoming`.
3. Service maps values as `enfonicaCallId = body.name`, `callerNumber = body.from`, `didNumber = body.to`.
4. If `callStatus` is missing (first leg), service looks up DID by `didNumber`.
5. If DID is missing, it logs a no-mapping call record and returns an empty response type (controller returns `<Response></Response>`).
6. If DID exists, service fetches tradie by `did.assignedTradieId`.
7. It sets `tradieNumber` from `did.tradieNumber` first, then fallback to `tradie.phoneNumber`.
8. It creates a call log with `enfonicaCallId`, `callerNumber`, `didNumber`, `tradieId`, `tradieNumber`, `status: initiated` (plus legacy fields `callStatus`/`fallbackUsed`).
9. It returns VoiceML that calls the tradie and sets `NextUri` to `/webhook/call?enfonicaCallId=...`.
10. On callback leg (`callStatus` present), service reads Enfonica ID from query param.
11. If status is `COMPLETED`, it updates the call log status to `completed` and returns `<Response/>`.
12. If status is `NOT_ANSWERED`, `BUSY`, or `FAILED`, it updates status to `no_answer` and returns VoiceML that calls SIP endpoint `sip:ai-bridge@127.0.0.1:5060?X-Call-Id=...`.
13. That SIP endpoint is where control moves from Enfonica into Asterisk/ARI.

### Hands off to

`dids/` for DID resolution, `tradies/` for tradie phone fallback/profile, `calls/` for call lifecycle persistence, then Asterisk SIP (`ai-bridge`) for AI fallback leg.

---

## dids/

### Purpose

This module stores DID-to-business/tradie mapping so inbound numbers can be routed to the correct tradie.

### Files

- `dids.module.ts` → registers DID Mongoose model and exports `DidsService`.
- `dids.service.ts` → provides DID lookup methods (`findByDidNumber`, `findById`, `ensureActive`).
- `schemas/did.schema.ts` → defines DID fields and timestamps.

### Flow

1. A DID record represents one inbound phone number assigned in the system.
2. Webhook first-leg logic calls `findByDidNumber(didNumber)` to resolve who should receive the call.
3. DID record provides `assignedTradieId` and optional `tradieNumber` override.
4. If DID is missing, webhook cannot route and logs no-mapping outcome.
5. `ensureActive` exists for active-state checks (available for runtime gating), though not used in current webhook path.

### Hands off to

`tradies/` using `assignedTradieId`, and `webhook/` continues call routing using the DID lookup result.

---

## calls/

### Purpose

This module is the persistent call state store for inbound Enfonica calls, callback outcomes, and AI summary attachment.

### Files

- `calls.module.ts` → registers `CallLog` model and exports `CallsService`.
- `calls.service.ts` → provides create/read/update methods for call lifecycle.
- `schemas/call-log.schema.ts` → defines call record shape including Enfonica ID, status, tradie link, and summary payload.

### Flow

1. On first webhook leg, a new call log is created with `enfonicaCallId`, `callerNumber`, `didNumber`, `tradieId`, `tradieNumber`, and `status: initiated`.
2. On callback leg with `COMPLETED`, webhook calls `updateCallStatus(enfonicaCallId, completed)`.
3. On callback leg with `NOT_ANSWERED/BUSY/FAILED`, webhook calls `updateCallStatus(enfonicaCallId, no_answer)`.
4. During AI booking save, voice module calls `updateCallSummary(enfonicaCallId, summaryPayload)`.
5. `updateCallSummary` stores structured summary and marks `status: completed`.
6. Voice module then calls `findByEnfonicaCallId(enfonicaCallId)` to load full call metadata (especially `tradieId` and timestamps) for notification.
7. Legacy fields (`callStatus`, `fallbackUsed`) still exist for backward compatibility and historical logging.

### Hands off to

`voice/` for summary update/fetch and `webhook/` for status updates during callback handling.

---

## tradies/

### Purpose

This module stores tradie profile and communication preferences used for dial routing and post-call notifications.

### Files

- `tradies.module.ts` → registers `Tradie` model and exports `TradiesService`.
- `tradies.service.ts` → provides tradie lookup by ID and phone.
- `schemas/tradie.schema.ts` → defines tradie identity/contact/preferences.

### Flow

1. Webhook first-leg uses `findById(did.assignedTradieId)` to resolve tradie details.
2. It uses `phoneNumber` as fallback dial target when DID does not carry `tradieNumber`.
3. Later, voice summary flow loads tradie by `callRecord.tradieId`.
4. It reads `email` and `notificationPreference` to decide whether to send missed-call summary email.
5. `notificationPreference` controls whether email notification is sent (`email` or `both` allows send).

### Hands off to

`webhook/` for dialing and `voice/` for notification decisioning.

---

## ari/

### Purpose

This module integrates with Asterisk ARI, manages call media bridges/external media, and launches AI voice sessions when SIP fallback calls arrive.

### Files

- `ari.module.ts` → wires ARI controller/service + RTP media + WebSocket gateway and imports `VoiceModule`.
- `ari.controller.ts` → exposes `GET /ari/health` for operational state.
- `ari.service.ts` → ARI event socket connection, Stasis call handling, bridge/media orchestration, OpenAI realtime bridge audio loop, and cleanup.
- `ari-rtp-media.service.ts` → RTP transport helper (session registration, packet parsing, ulaw send/receive).
- `ari-websocket.gateway.ts` → WebSocket externalMedia server for Asterisk audio streaming.

### Flow

1. On startup, ARI service creates HTTP client/auth and optionally auto-connects ARI event WebSocket (`ASTERISK_ARI_AUTO_CONNECT=true`).
2. It listens for ARI events; `StasisStart` is the trigger for AI call handling.
3. In `StasisStart`, it reads `X-Call-Id` from channel vars: `PJSIP_HEADER(recv,X-Call-Id)` then fallback `X-Call-Id`.
4. It also reads `customerNumber` from `channel.caller.number` and `didNumber` from `channel.connected.number`.
5. It calls `VoiceService.handleIncomingCall(channel, enfonicaCallId, customerNumber, didNumber)`.
6. It answers channel, creates bridge, attaches inbound channel, creates external media channel, and attaches media channel.
7. It starts AI realtime session and relays media via WebSocket (preferred) or RTP fallback compatibility path.
8. On channel end/destroy, it cleans up bridge/media/AI session.

### Hands off to

`voice/` for AI conversation and booking capture; audio transport runs through `ari-websocket.gateway.ts`/`ari-rtp-media.service.ts`.

---

## voice/

### Purpose

This module runs the conversational AI voice agent, persists booking details, updates call summaries, and triggers tradie notifications.

### Files

- `voice.module.ts` → wires voice controller/gateway/service, customer schema, and imports `DidsModule`, `TradiesModule`, `CallsModule`, `CommonModule`.
- `voice.controller.ts` → exposes legacy HTTP VoiceML endpoints (`POST /voice/incoming`, `POST /voice/callback`).
- `voice.gateway.ts` → browser Socket.IO gateway for realtime session control, audio relay, and event forwarding.
- `voice.service.ts` → core logic: webhook-based voice path, ARI-triggered AI session path, OpenAI/ElevenLabs orchestration, function-call booking save, call summary update, and email trigger.
- `voiceml.builder.ts` → helper to build XML VoiceML responses (`Say`, `Dial`).
- `Schema/customer.schema.ts` → booking/customer document schema saved by AI function call.
- `Dto's/voice.dto.ts` → Swagger DTO for voice payload metadata.
- `voice.controller.spec.ts` → minimal controller existence test.
- `voice.service.spec.ts` → minimal service existence test with mocked dependencies.

### Flow

1. In the current fallback architecture, ARI triggers this module through `handleIncomingCall(...)` when Asterisk receives SIP call from webhook fallback VoiceML.
2. `handleIncomingCall` creates a realtime AI session keyed by call/channel ID.
3. It stores call context in session memory: `enfonicaCallId`, `customerNumber`, and `didNumber`.
4. AI session is configured with system prompt and `save_customer_booking` tool.
5. During conversation, transcripts/audio deltas flow through event handlers.
6. When model emits `save_customer_booking`, `handleFunctionCall` parses arguments and saves a `Customer` document to MongoDB.
7. If `enfonicaCallId` exists, it updates the matching call log summary via `callsService.updateCallSummary(...)`.
8. It loads the full call record using `findByEnfonicaCallId` and then loads tradie profile via `tradiesService.findById`.
9. If tradie has email and preference allows email (`email`/`both`), it sends a “Missed Call Summary” email including call numbers, time, summary, and full captured details.
10. It sends function call output back to the realtime model and continues/finishes conversation.
11. `closeSession` cleans up when session ends.

### Hands off to

`calls/` to update summary status and fetch call metadata; `tradies/` to resolve notification target/prefs; `common/notification.service` to send email.

---

## common/

### Purpose

This module provides shared communication services, including the notification email sender used by the voice summary flow.

### Files

- `common.module.ts` → exports shared providers including `NotificationService` (and `MailModule`).
- `notification.service.ts` → generic SMTP email sender used for missed-call summaries.
- `mail/mail.module.ts` → registers `MailService` for auth/OTP and password reset mail flows.
- `mail/mail.service.ts` → sends OTP and password reset emails via nodemailer and config-based SMTP.

### Flow

1. `NotificationService` initializes a nodemailer transporter from environment SMTP settings.
2. Voice module injects this service through `CommonModule`.
3. After AI booking summary is persisted and tradie preference is validated, voice module calls `sendEmail(to, subject, body)`.
4. `sendEmail` sends plain-text mail using `from = SMTP_USER`.
5. SMTP values used are `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`.

### Hands off to

External SMTP server (Gmail SMTP as configured) to deliver the summary email to the tradie.

---

## End-to-End Flow (Customer Call to Tradie Email)

1. A customer dials a DID number owned by the business.
2. Enfonica sends inbound webhook to `POST /webhook/call` with `name`, `from`, and `to`.
3. Webhook resolves the DID record by `to` and finds the assigned tradie.
4. Webhook chooses tradie dial target from `did.tradieNumber` or fallback `tradie.phoneNumber`.
5. Webhook creates a call log record tied to Enfonica call ID with status `initiated`.
6. Webhook returns VoiceML instructing Enfonica to dial the tradie and call back to `/webhook/call?enfonicaCallId=...` when leg completes.
7. If tradie answers and call is completed, Enfonica callback sends `callStatus=COMPLETED`; webhook marks call log as `completed` and returns `<Response/>`.
8. If tradie does not answer (`NOT_ANSWERED`, `BUSY`, `FAILED`), webhook marks call log as `no_answer`.
9. Webhook returns fallback VoiceML telling Enfonica to place SIP call to `sip:ai-bridge@127.0.0.1:5060?X-Call-Id=...`.
10. Asterisk receives that SIP call and emits `StasisStart` into ARI.
11. ARI reads `X-Call-Id` header and call numbers from channel data.
12. ARI invokes voice agent with channel context plus `enfonicaCallId`, `customerNumber`, and `didNumber`.
13. Voice agent runs realtime AI conversation with caller and gathers booking details.
14. On `save_customer_booking`, voice service saves a `Customer` record in MongoDB.
15. Voice service updates the original call log summary by `enfonicaCallId` and marks status `completed`.
16. Voice service loads the same call log, gets `tradieId`, and loads tradie profile.
17. If tradie notification preference allows email and email exists, voice service composes missed-call summary email including call numbers, timestamp, and full booking details.
18. `NotificationService` sends the email through configured SMTP.
19. Tradie receives the missed-call summary and can call customer back with complete context.

Generated: May 13, 2026
