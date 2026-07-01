import { Controller, Get, Post, Request, UseGuards, Req, Res, BadRequestException, Param, Body, Query, Logger } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth } from '@nestjs/swagger';

@Controller('payments')
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(private readonly paymentsService: PaymentsService) { }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Get('status')
  async getStatus(@Request() req) {
    return this.paymentsService.getStatus(req.user?.companyId);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Post('create-checkout')
  async createCheckout(@Request() req) {
    return this.paymentsService.createCheckoutSession(req.user?.companyId);
  }

  /**
   * Manually sync payment status from Stripe API.
   * Use this when webhooks can't reach your server (e.g. localhost testing).
   */
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Post('sync')
  async syncPayment(@Request() req) {
    return this.paymentsService.syncPaymentStatus(req.user?.companyId);
  }

  @Post('webhook')
  async handleWebhook(@Req() req: any, @Res() res: any) {
    const signature = req.headers['stripe-signature'] as string;
    this.logger.log(`Received Stripe webhook event notification (signature length: ${signature?.length || 0})`);

    const payload = req.rawBody;
    if (!payload) {
      throw new BadRequestException('Raw body is missing. Ensure rawBody is enabled in main.ts');
    }

    try {
      await this.paymentsService.handleWebhook(signature, payload);
      res.status(200).send();
    } catch (err) {
      res.status(400).send(`Webhook Error: ${err.message}`);
    }
  }

  /**
   * TEST ONLY — Manually set how many days remain on a company subscription.
   * Usage: POST /payments/test/set-days/:companyId   body: { "days": 1 }
   * No auth required for easy Postman testing.
   */
  @Post('test/set-days/:companyId')
  async testSetDays(
    @Param('companyId') companyId: string,
    @Body() body: { days?: number },
  ) {
    const days = Number(body?.days ?? 1);
    return this.paymentsService.setDaysRemaining(companyId, days);
  }
}

@Controller()
export class PaymentPagesController {
  private readonly logger = new Logger(PaymentPagesController.name);

  constructor(private readonly paymentsService: PaymentsService) { }

  @Get('payment-success')
  async paymentSuccess(@Query('session_id') sessionId: string, @Res() res: any) {
    this.logger.log(`Handling payment-success redirect. session_id: ${sessionId}`);
    if (sessionId) {
      try {
        await this.paymentsService.syncPaymentStatusBySessionId(sessionId);
      } catch (err: any) {
        this.logger.error(`Error during payment-success sync: ${err.message}`);
      }
    }

    res.status(200).send(`
      <!DOCTYPE html>
      <html>
      <head><title>Payment Successful</title></head>
      <body style="font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f0fdf4;">
        <div style="text-align: center; padding: 40px; background: white; border-radius: 16px; box-shadow: 0 4px 24px rgba(0,0,0,0.1);">
          <div style="font-size: 64px;">✅</div>
          <h1 style="color: #16a34a; margin: 16px 0 8px;">Payment Successful!</h1>
          <p style="color: #666; font-size: 18px;">Your subscription is now active. You can close this page.</p>
        </div>
      </body>
      </html>
    `);
  }

  @Get('payment-cancel')
  paymentCancel(@Res() res: any) {
    res.status(200).send(`
      <!DOCTYPE html>
      <html>
      <head><title>Payment Cancelled</title></head>
      <body style="font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #fef2f2;">
        <div style="text-align: center; padding: 40px; background: white; border-radius: 16px; box-shadow: 0 4px 24px rgba(0,0,0,0.1);">
          <div style="font-size: 64px;">❌</div>
          <h1 style="color: #dc2626; margin: 16px 0 8px;">Payment Cancelled</h1>
          <p style="color: #666; font-size: 18px;">No charges were made. You can try again anytime.</p>
        </div>
      </body>
      </html>
    `);
  }
}
