import { Injectable } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class MailService {
  private transporter;

  constructor(private configService: ConfigService) {
    this.transporter = nodemailer.createTransport({
      host: this.configService.get<string>('SMTP_HOST'),
      port: this.configService.get<number>('SMTP_PORT'),
      secure: this.configService.get<boolean>('SMTP_SECURE'),
      auth: {
        user: this.configService.get<string>('SMTP_USER'),
        pass: this.configService.get<string>('SMTP_PASS'),
      },
    });
  }

  async sendOtpEmail(to: string, otp: string) {
    await this.transporter.sendMail({
      from: `"Omni Suite AI" <${this.configService.get<string>('SMTP_USER')}>`,
      to, // recipient from user form
      subject: 'Email Verification OTP',
      html: `
        <h2>Email Verification</h2>
        <p>Your OTP is:</p>
        <h1>${otp}</h1>
        <p>This OTP will expire in 10 minutes.</p>
      `,
    });
  }

  async sendNewPasswordEmail(to: string, newPassword: string) {
    await this.transporter.sendMail({
      from: `"Support" <${this.configService.get('SMTP_USER')}>`,
      to,
      subject: 'Your New Password',
      html: `
        <h2>Password Reset</h2>
        <p>Your new password is:</p>
        <h3>${newPassword}</h3>
        <p>Please login and change it immediately.</p>
      `,
    });
  }

  async sendCallForwardingInstructionsEmail(to: string, didNumber: string, country?: string) {
    const htmlContent = `
      <div style="font-family: sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h1 style="color: #0056b3;">📞 Call Forwarding Setup Instructions</h1>
        <p>Thank you for your purchase!</p>
        <p>To ensure your calls are forwarded to your new DID number, please enable <strong>Conditional Call Forwarding</strong> on your mobile.</p>
        <div style="background-color: #f8f9fa; border-left: 4px solid #0056b3; padding: 15px; margin: 20px 0;">
          <strong>Your DID Number:</strong> ${didNumber}
        </div>
        <p><em>(You can also find your assigned DID number in your <strong>Dashboard (top-right corner)</strong>.)</em></p>

        <h2 style="color: #444; border-bottom: 2px solid #eee; padding-bottom: 5px;">Why are there 3 forwarding options?</h2>
        <p>We recommend enabling <strong>all three</strong> forwarding conditions so that your calls are handled in every possible situation:</p>
        <ul>
          <li><strong>No Answer</strong> – Your phone rings but you don't answer. After the configured delay, the call is forwarded.</li>
          <li><strong>Busy</strong> – You're already on another call. The new call is forwarded immediately.</li>
          <li><strong>Unreachable</strong> – Your phone is switched off, has no signal, or is in flight mode. The call is forwarded immediately.</li>
        </ul>
        <p>If you only want forwarding in certain situations, you can enable only the conditions that suit your needs.</p>
        <hr style="border: none; border-top: 1px solid #ddd; margin: 30px 0;">

        ${country === 'NZ' ? `
        <h1 style="color: #222;">New Zealand</h1>
        <p><em>> Use your DID number in international format (+64...) where required by your carrier.</em></p>
        
        <h2 style="color: #0056b3;">Spark</h2>
        <p><strong>No Answer</strong><br><code>*61*${didNumber}#</code></p>
        <p><em>(Optional delay example: <code>*61*${didNumber}*11#</code>)</em></p>
        <p><strong>Busy</strong><br><code>*67*${didNumber}#</code></p>
        <p><strong>Unreachable</strong><br><code>*62*${didNumber}#</code></p>
        <hr style="border: none; border-top: 1px solid #ddd; margin: 20px 0;">

        <h2 style="color: #0056b3;">One NZ (formerly Vodafone)</h2>
        <p><strong>No Answer</strong><br><code>**61*${didNumber}#</code></p>
        <p><strong>Busy</strong><br><code>**67*${didNumber}#</code></p>
        <p><strong>Unreachable</strong><br><code>**62*${didNumber}#</code></p>
        <p><em>Additional codes: Check status: <code>#61*11#</code> | Cancel No Answer forwarding: <code>#61**11#</code></em></p>
        <hr style="border: none; border-top: 1px solid #ddd; margin: 20px 0;">

        <h2 style="color: #0056b3;">2degrees</h2>
        <p><strong>No Answer</strong><br><code>*61*${didNumber}#</code></p>
        <p><strong>Busy</strong><br><code>*67*${didNumber}#</code></p>
        <p><strong>Unreachable</strong><br><code>*62*${didNumber}#</code></p>
        <hr style="border: none; border-top: 1px solid #ddd; margin: 30px 0;">
        ` : `
        <h1 style="color: #222;">Australia</h1>
        
        <h2 style="color: #0056b3;">Telstra</h2>
        <p><strong>No Answer</strong><br><code>*61*${didNumber}*[10-30]#</code></p>
        <p><strong>Busy</strong><br><code>*67*${didNumber}#</code></p>
        <p><strong>Unreachable</strong><br><code>*62*${didNumber}#</code></p>
        <p><em><strong>Notes:</strong> Default ring time is approximately 15 seconds. To change the ring delay (up to 30 seconds), contact Telstra on <strong>132 200</strong>.</em></p>
        <hr style="border: none; border-top: 1px solid #ddd; margin: 20px 0;">

        <h2 style="color: #0056b3;">Optus</h2>
        <p><strong>No Answer</strong><br><code>**61*${didNumber}**[Seconds]#</code></p>
        <p><strong>Busy</strong><br><code>**67*${didNumber}#</code></p>
        <p><strong>Unreachable</strong><br><code>**62*${didNumber}#</code></p>
        <p><em><strong>Notes:</strong> Contact <strong>133 937</strong> if you need to adjust the ring delay.</em></p>
        <hr style="border: none; border-top: 1px solid #ddd; margin: 20px 0;">

        <h2 style="color: #0056b3;">Vodafone / TPG</h2>
        <p><strong>No Answer</strong><br><code>*61*${didNumber}#</code></p>
        <p><strong>Busy</strong><br><code>*67*${didNumber}#</code></p>
        <p><strong>Unreachable</strong><br><code>*62*${didNumber}#</code></p>
        <p><em><strong>Notes:</strong> Ring delay is typically fixed at around 15 seconds. Contact your provider if you need it changed.</em></p>

        <div style="background-color: #fff3cd; border-left: 4px solid #ffecb5; padding: 15px; margin: 20px 0;">
          <strong>Important:</strong> Some prepaid services (including certain Vodafone/TPG, Kogan, amaysim, Felix and other MVNO plans) may not support conditional call forwarding. If you're unable to activate forwarding, please contact your mobile provider.
        </div>
        <hr style="border: none; border-top: 1px solid #ddd; margin: 30px 0;">
        `}

        <h1 style="color: #222;">Universal GSM Codes</h1>
        <p><strong>Cancel all conditional forwarding</strong><br><code>##004#</code></p>
        <p><strong>Check current forwarding status</strong><br><code>*#004#</code></p>
        <hr style="border: none; border-top: 1px solid #ddd; margin: 30px 0;">

        <h2 style="color: #444;">Don't see your mobile provider?</h2>
        <p>If your mobile operator is not listed above, don't worry.</p>
        <p>Most providers support Conditional Call Forwarding using similar GSM/USSD codes. Please refer to your mobile provider's official documentation or customer support and use the equivalent <strong>No Answer</strong>, <strong>Busy</strong>, and <strong>Unreachable</strong> forwarding codes with your DID number.</p>
        <p>If you need any assistance, please contact our support team—we'll be happy to help you get everything set up.</p>
      </div>
    `;

    await this.transporter.sendMail({
      from: `"Support" <${this.configService.get('SMTP_USER')}>`,
      to,
      subject: '📞 Call Forwarding Setup Instructions',
      html: htmlContent,
    });
  }
}
