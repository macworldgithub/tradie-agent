export class WebhookCallDto {
  name?: string; // Enfonica call resource name
  from: string; // caller number
  to: string; // DID number
  callStatus?: string; // optional, provided on fallback events
}
