import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { User, UserDocument } from '../auth/schemas/user.schema';
import { Did, DidDocument } from '../dids/schemas/did.schema';
import { AdminService } from '../admin/admin.service';
import { EnfonicaService } from '../enfonica/enfonica.service';
import Stripe from 'stripe';

@Injectable()
export class PaymentsService {
  private stripe: any;
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    @InjectModel(Did.name) private didModel: Model<DidDocument>,
    private configService: ConfigService,
    private adminService: AdminService,
    private enfonicaService: EnfonicaService,
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
        if (customerId && !user.stripeCustomerId) {
          user.stripeCustomerId = customerId;
        }

        if (user.phoneNumberInstanceName) {
          // Returning user — number already exists, just extend/restore
          this.logger.log(`Returning user payment for ${user.email} (companyId: ${user._id})`);
          const did = await this.didModel.findOne({ companyId: String(user._id) }).exec();
          
          if (did) {
            const wasUnmapped = did.unassignedTradieIds && did.unassignedTradieIds.length > 0;

            if (wasUnmapped) {
              // Service was stopped by scheduler — tradies are in unassignedTradieIds, restore them
              this.logger.log(`Service was stopped. Remapping tradies for ${user.email}`);
              await this.adminService.remapDid(String(did._id));
            } else {
              // User is still active (e.g. 2 days left) — tradies already mapped, just extend
              this.logger.log(`Service still active. Skipping remap, just renewing for ${user.email}`);
            }
            
            // Always extend the subscription by 30 days
            await this.adminService.renewDid(String(did._id));
          } else {
            this.logger.warn(`Returning user has no DID record to remap/renew: ${user._id}`);
          }
          
          user.hasPaid = true;
          user.lastPaymentDate = new Date();
          
          // Stack 30 days onto remaining time: max(currentExpiry, now) + 30 days
          const now = new Date();
          const currentExpiry = user.subscriptionExpiresAt ? new Date(user.subscriptionExpiresAt) : now;
          const baseDate = currentExpiry > now ? currentExpiry : now;
          user.subscriptionExpiresAt = new Date(baseDate.getTime() + (30 * 24 * 60 * 60 * 1000));
          
          await user.save();
        } else {
          // First-time user: trigger full Enfonica purchase flow
          this.logger.log(`First-time user payment. Triggering Enfonica flow for ${user.email}`);
          user.hasPaid = true;
          user.lastPaymentDate = new Date();
          await user.save();
          
          // Step 2, 3, 4 will be encapsulated in this method in EnfonicaService
          await this.enfonicaService.provisionFirstTimeDid(String(user._id));
        }
      } else {
        this.logger.warn(`User not found for Stripe customer ${customerId} / email ${email}`);
      }
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleSubscriptionAutoExpiry() {
    this.logger.log('Running daily subscription auto-expiry check...');
    const now = new Date();
    
    // Find users where subscriptionExpiresAt < now AND hasPaid = true
    const expiredUsers = await this.userModel.find({
      hasPaid: true,
      subscriptionExpiresAt: { $lt: now }
    }).exec();

    for (const user of expiredUsers) {
      try {
        const did = await this.didModel.findOne({ companyId: String(user._id) }).exec();
        if (did) {
          // unmapDid handles unmapping all tradies in bulk and sets hasPaid = false
          await this.adminService.unmapDid(String(did._id));
        } else {
          this.logger.warn(`Expired user ${user._id} has no DID record to unmap.`);
          user.hasPaid = false;
          await user.save();
        }
        
        this.logger.log(`Subscription expired for user ${user._id} (${user.email}) (Enfonica number: ${user.phoneNumber || 'unknown'})`);
      } catch (err: any) {
        this.logger.error(`Failed to process expiry for user ${user._id}: ${err.message}`, err.stack);
      }
    }
    
    this.logger.log(`Completed auto-expiry check. Processed ${expiredUsers.length} users.`);
  }
}
