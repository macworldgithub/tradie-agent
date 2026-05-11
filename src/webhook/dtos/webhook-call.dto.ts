export class WebhookCallDto {
  from: string; // caller number
  to: string; // DID number
  callStatus?: string; // optional, provided on fallback events
}
