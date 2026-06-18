import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { User, UserDocument } from '../auth/schemas/user.schema';
import { Did, DidDocument } from '../dids/schemas/did.schema';
import Stripe from 'stripe';

@Injectable()
export class PaymentsService {
  private stripe: any;
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    @InjectModel(Did.name) private didModel: Model<DidDocument>,
    private configService: ConfigService,
  ) {
    const stripeKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    if (stripeKey) {
      this.stripe = new Stripe(stripeKey, { apiVersion: '2026-05-27.dahlia' });
    }
  }

  private daysSince(date?: Date): number {
    if (!date) return 30;
    const diff = new Date().getTime() - new Date(date).getTime();
    return Math.floor(diff / (1000 * 3600 * 24));
  }

  async getStatus(companyId: string) {
    const user = await this.userModel.findById(companyId).lean().exec();
    const did = await this.didModel.findOne({ companyId }).lean().exec();

    let daysRemaining = 0;
    if (did?.subscriptionStartDate) {
      daysRemaining = Math.max(0, 30 - this.daysSince(did.subscriptionStartDate));
    }

    return {
      hasPaid: user?.hasPaid || false,
      lastPaymentDate: user?.lastPaymentDate || null,
      daysRemaining
    };
  }

  async createCheckoutSession(companyId: string) {
    if (!this.stripe) throw new BadRequestException('Stripe is not configured');

    const user = await this.userModel.findById(companyId).exec();
    if (!user) throw new BadRequestException('User not found');

    const priceId = this.configService.get<string>('STRIPE_PRICE_ID');
    const successUrl = this.configService.get<string>('STRIPE_SUCCESS_URL');
    const cancelUrl = this.configService.get<string>('STRIPE_CANCEL_URL');

    if (!priceId || !successUrl || !cancelUrl) {
      throw new BadRequestException('Stripe configuration missing');
    }

    let customerId = user.stripeCustomerId;

    if (!customerId) {
      const customer = await this.stripe.customers.create({
        email: user.email,
        name: user.companyName,
        metadata: { companyId: String(user._id) }
      });
      customerId = customer.id;
      user.stripeCustomerId = customerId;
      await user.save();
    }

    const session = await this.stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: companyId,
    });

    return { url: session.url };
  }

  async handleWebhook(signature: string, payload: Buffer) {
    if (!this.stripe) throw new BadRequestException('Stripe is not configured');

    const webhookSecret = this.configService.get<string>('STRIPE_WEBHOOK_SECRET');
    if (!webhookSecret) throw new BadRequestException('Stripe webhook secret not configured');

    let event: any;

    try {
      event = this.stripe.webhooks.constructEvent(payload, signature, webhookSecret);
    } catch (err) {
      this.logger.error(`Webhook signature verification failed: ${err.message}`);
      throw new BadRequestException(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as any;
      const customerId = session.customer as string;
      const email = session.customer_details?.email;
      
      const conditions: any[] = [
        { stripeCustomerId: customerId },
        { email: email }
      ];

      if (session.client_reference_id) {
        conditions.unshift({ _id: session.client_reference_id });
      }

      const user = await this.userModel.findOne({ $or: conditions }).exec();

      if (user) {
        user.hasPaid = true;
        user.lastPaymentDate = new Date();
        if (customerId && !user.stripeCustomerId) {
          user.stripeCustomerId = customerId;
        }
        await user.save();
        this.logger.log(`Payment confirmed for user ${user.email}`);
      } else {
        this.logger.warn(`User not found for Stripe customer ${customerId} / email ${email}`);
      }
    }
  }
}
