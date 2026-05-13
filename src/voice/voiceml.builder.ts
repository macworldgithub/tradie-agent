export class VoiceMlBuilder {
  private static readonly xmlDeclaration =
    '<?xml version="1.0" encoding="UTF-8"?>';

  static say(message: string): string {
    return `${this.xmlDeclaration}<Response><Say>${this.escapeXml(
      message,
    )}</Say></Response>`;
  }

  static dialTradie(options: {
    callerId: string;
    tradieNumber: string;
    nextUri: string;
    timeoutSeconds: number;
  }): string {
    const { callerId, tradieNumber, nextUri, timeoutSeconds } = options;
    return (
      `${this.xmlDeclaration}` +
      `<Response><Dial CallerId="${this.escapeXml(
        callerId,
      )}" TimeoutSeconds="${timeoutSeconds}" NextUri="${this.escapeXml(
        nextUri,
      )}"><Number>${this.escapeXml(tradieNumber)}</Number></Dial></Response>`
    );
  }

  private static escapeXml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}
