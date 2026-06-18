import { Controller, Get, Post, Request, UseGuards, Req, Res, RawBodyRequest, BadRequestException } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth } from '@nestjs/swagger';
import type { Request as ExpressRequest, Response } from 'express';

@Controller('payments')
export class PaymentsController {
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

  @Post('webhook')
  async handleWebhook(@Req() req: any, @Res() res: any) {
    const signature = req.headers['stripe-signature'] as string;

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
}
