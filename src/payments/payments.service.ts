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
    const stripeSecret = this.configService.get<string>('STRIPE_SECRET_KEY');
    if (!stripeSecret) {
      throw new Error('Stripe secret key not configured');
    }

    this.stripe = new Stripe(stripeSecret, {
      apiVersion: '2026-05-27.dahlia',
    });
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  private daysSince(date?: Date): number {
    if (!date) return 30;
    const diff = new Date().getTime() - new Date(date).getTime();
    return Math.floor(diff / (1000 * 3600 * 24));
  }

  /**
   * Safely parse a Stripe timestamp into a JS Date.
   * Handles Unix seconds, Unix ms, ISO strings, and Date objects.
   */
  private safeDate(value: any): Date {
    if (!value) return new Date();
    if (value instanceof Date) return value;
    if (typeof value === 'string') return new Date(value);
    if (typeof value === 'number') {
      return value < 1e12 ? new Date(value * 1000) : new Date(value);
    }
    return new Date();
  }

  // ─── Status ─────────────────────────────────────────────────────────

  async getStatus(companyId: string) {
    const user = await this.userModel.findById(companyId).lean().exec();
    const did = await this.didModel.findOne({ companyId }).lean().exec();

    let daysRemaining = 0;
    if (user?.subscriptionExpiresAt) {
      const msRemaining = new Date(user.subscriptionExpiresAt).getTime() - Date.now();
      daysRemaining = Math.max(0, Math.ceil(msRemaining / (1000 * 3600 * 24)));
    } else if (did?.subscriptionStartDate) {
      daysRemaining = Math.max(0, 30 - this.daysSince(did.subscriptionStartDate));
    } else if (user?.hasPaid && user?.lastPaymentDate) {
      daysRemaining = Math.max(0, 30 - this.daysSince(user.lastPaymentDate));
    }

    return {
      hasPaid: user?.hasPaid || false,
      lastPaymentDate: user?.lastPaymentDate || null,
      subscriptionExpiresAt: user?.subscriptionExpiresAt || null,
      daysRemaining,
    };
  }

  // ─── TEST HELPER: manually set days remaining ───────────────────────

  async setDaysRemaining(companyId: string, days: number) {
    const user = await this.userModel.findById(companyId);
    if (!user) throw new BadRequestException(`User ${companyId} not found`);

    // Set subscriptionExpiresAt so daysRemaining = days from now
    const newExpiry = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    user.subscriptionExpiresAt = newExpiry;
    await user.save();

    // Also backdate subscriptionStartDate on the DID so the fallback calc matches
    const did = await this.didModel.findOne({ companyId: String(user._id) });
    if (did) {
      did.subscriptionStartDate = new Date(Date.now() - (30 - days) * 24 * 60 * 60 * 1000);
      await did.save();
    }

    this.logger.warn(`[TEST] Set daysRemaining=${days} for user ${companyId}. subscriptionExpiresAt=${newExpiry.toISOString()}`);

    return {
      companyId,
      daysRemaining: days,
      subscriptionExpiresAt: newExpiry,
    };
  }

  // ─── Sync (for local testing — bypasses webhooks) ───────────────────

  async syncPaymentStatus(companyId: string) {
    if (!this.stripe) throw new BadRequestException('Stripe is not configured');

    const user = await this.userModel.findById(companyId).exec();
    if (!user) throw new BadRequestException('User not found');

    if (!user.stripeCustomerId) {
      return {
        synced: false,
        message: 'No Stripe customer ID found. User has not started checkout yet.',
        hasPaid: false,
      };
    }

    // Check for active subscriptions
    const subscriptions = await this.stripe.subscriptions.list({
      customer: user.stripeCustomerId,
      status: 'active',
      limit: 1,
    });

    if (subscriptions.data.length > 0) {
      const subscription = subscriptions.data[0];

      // Run the same 3-scenario logic as the webhook
      await this.processSuccessfulPayment(user);

      // Also store subscription ID
      user.stripeSubscriptionId = subscription.id;
      await user.save();

      this.logger.log(
        `Payment synced for user ${user.email} — subscription ${subscription.id} is active`,
      );

      const msRemaining = user.subscriptionExpiresAt
        ? new Date(user.subscriptionExpiresAt).getTime() - Date.now()
        : 30 * 24 * 3600 * 1000;

      return {
        synced: true,
        message: 'Active subscription found. Payment status updated.',
        hasPaid: true,
        lastPaymentDate: user.lastPaymentDate,
        subscriptionId: subscription.id,
        subscriptionExpiresAt: user.subscriptionExpiresAt,
        daysRemaining: Math.max(0, Math.ceil(msRemaining / (1000 * 3600 * 24))),
      };
    }

    // Check for completed checkout sessions as fallback
    const sessions = await this.stripe.checkout.sessions.list({
      customer: user.stripeCustomerId,
      limit: 5,
    });

    const completedSession = sessions.data.find(
      (s: any) => s.status === 'complete' && s.payment_status === 'paid',
    );

    if (completedSession) {
      await this.processSuccessfulPayment(user);

      this.logger.log(
        `Payment synced for user ${user.email} — checkout session completed`,
      );

      const msRemaining = user.subscriptionExpiresAt
        ? new Date(user.subscriptionExpiresAt).getTime() - Date.now()
        : 30 * 24 * 3600 * 1000;

      return {
        synced: true,
        message: 'Completed checkout session found. Payment status updated.',
        hasPaid: true,
        lastPaymentDate: user.lastPaymentDate,
        subscriptionExpiresAt: user.subscriptionExpiresAt,
        daysRemaining: Math.max(0, Math.ceil(msRemaining / (1000 * 3600 * 24))),
      };
    }

    return {
      synced: false,
      message: 'No active subscription or completed payment found in Stripe.',
      hasPaid: false,
    };
  }

  // ─── Checkout Session Creation ──────────────────────────────────────

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
        metadata: { companyId: String(user._id) },
      });
      customerId = customer.id;
      user.stripeCustomerId = customerId;
      await user.save();
    }

    const session = await this.stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: companyId,
    });

    return { url: session.url };
  }

  // ─── Webhook Entry Point ────────────────────────────────────────────

  async handleWebhook(signature: string, payload: Buffer) {
    if (!this.stripe) throw new BadRequestException('Stripe is not configured');

    const webhookSecret = this.configService.get<string>('STRIPE_WEBHOOK_SECRET');
    if (!webhookSecret)
      throw new BadRequestException('Stripe webhook secret not configured');

    let event: any;

    try {
      event = this.stripe.webhooks.constructEvent(payload, signature, webhookSecret);
    } catch (err) {
      this.logger.error(`Webhook signature verification failed: ${err.message}`);
      throw new BadRequestException(`Webhook Error: ${err.message}`);
    }

    this.logger.log(`Received Stripe webhook event: ${event.type}`);

    switch (event.type) {
      case 'checkout.session.completed':
        await this.handleCheckoutCompleted(event.data.object);
        break;
      case 'invoice.paid':
        await this.handleInvoicePaid(event.data.object);
        break;
      case 'invoice.payment_failed':
        await this.handleInvoicePaymentFailed(event.data.object);
        break;
      case 'customer.subscription.deleted':
        await this.handleSubscriptionCancelled(event.data.object);
        break;
      default:
        this.logger.log(`Unhandled event type: ${event.type}`);
    }
  }

  // ─── Webhook Handlers ───────────────────────────────────────────────

  /**
   * checkout.session.completed — the main handler that implements the 3 scenarios:
   *   Scenario 1: First-time payment (phoneNumberInstanceName is null)
   *   Scenario 2: Active renewal (tradies still mapped, just extend)
   *   Scenario 3: Service restoration (tradies were unmapped by cron, restore them)
   */
  private async handleCheckoutCompleted(session: any) {
    const customerId = session.customer as string;
    const email = session.customer_details?.email;

    const user = await this.findUserByStripeInfo(customerId, email, session.client_reference_id);

    if (!user) {
      this.logger.warn(
        `User not found for Stripe customer ${customerId} / email ${email}`,
      );
      return;
    }

    // Save stripe IDs immediately
    if (customerId && !user.stripeCustomerId) {
      user.stripeCustomerId = customerId;
    }
    if (session.subscription) {
      user.stripeSubscriptionId = session.subscription;
    }

    // Run the 3-scenario payment logic
    await this.processSuccessfulPayment(user);
  }

  /**
   * invoice.paid — fires on subscription renewals (monthly recurring).
   * Uses the same 3-scenario logic to extend/restore service.
   */
  private async handleInvoicePaid(invoice: any) {
    const customerId = invoice.customer as string;
    const email = invoice.customer_email;

    const user = await this.findUserByStripeInfo(customerId, email);

    if (!user) {
      this.logger.warn(`User not found for invoice customer ${customerId}`);
      return;
    }

    await this.processSuccessfulPayment(user);
    this.logger.log(`Invoice paid for user ${user.email} — subscription renewed`);
  }

  private async handleInvoicePaymentFailed(invoice: any) {
    const customerId = invoice.customer as string;
    const email = invoice.customer_email;

    const user = await this.findUserByStripeInfo(customerId, email);

    if (user) {
      this.logger.warn(
        `Payment failed for user ${user.email}. Subscription may be at risk.`,
      );
    }
  }

  private async handleSubscriptionCancelled(subscription: any) {
    const customerId = subscription.customer as string;

    const user = await this.userModel
      .findOne({ stripeCustomerId: customerId })
      .exec();

    if (user) {
      user.hasPaid = false;
      await user.save();
      this.logger.log(`Subscription cancelled for user ${user.email}`);
    }
  }

  // ─── Core 3-Scenario Payment Logic ──────────────────────────────────

  /**
   * The single source of truth for what happens when a payment succeeds.
   * Called by: handleCheckoutCompleted, handleInvoicePaid, syncPaymentStatus.
   *
   * Scenario 1 — First-time: phoneNumberInstanceName is null
   *   → Set hasPaid, call enfonicaService.provisionFirstTimeDid()
   *
   * Scenario 2 — Active renewal: phoneNumberInstanceName exists, unassignedTradieIds is empty
   *   → Skip remap, call adminService.renewDid(), stack 30 days
   *
   * Scenario 3 — Service restoration: phoneNumberInstanceName exists, unassignedTradieIds has entries
   *   → Call adminService.remapDid(), then renewDid(), fresh 30 days from today
   */
  private async processSuccessfulPayment(user: UserDocument) {
    const userId = String(user._id);

    if (user.phoneNumberInstanceName) {
      // ─── Returning user (Scenario 2 or 3) ───
      this.logger.log(`Returning user payment for ${user.email} (companyId: ${userId})`);

      const did = await this.didModel.findOne({ companyId: userId }).exec();

      if (did) {
        const wasUnmapped = did.unassignedTradieIds && did.unassignedTradieIds.length > 0;

        if (wasUnmapped) {
          // Scenario 3: Service was stopped by scheduler — restore tradies
          this.logger.log(`Service was stopped. Remapping tradies for ${user.email}`);
          await this.adminService.remapDid(String(did._id));
        } else {
          // Scenario 2: Still active — tradies already mapped, just extend
          this.logger.log(`Service still active. Skipping remap, just renewing for ${user.email}`);
        }

        // Always extend the DID subscription
        await this.adminService.renewDid(String(did._id));
      } else {
        this.logger.warn(`Returning user has no DID record to remap/renew: ${userId}`);
      }

      // Update user record
      user.hasPaid = true;
      user.lastPaymentDate = new Date();

      // Stack 30 days onto remaining time: max(currentExpiry, now) + 30 days
      const now = new Date();
      const currentExpiry = user.subscriptionExpiresAt
        ? new Date(user.subscriptionExpiresAt)
        : now;
      const baseDate = currentExpiry > now ? currentExpiry : now;
      user.subscriptionExpiresAt = new Date(
        baseDate.getTime() + 30 * 24 * 60 * 60 * 1000,
      );

      await user.save();
      this.logger.log(
        `Returning user ${user.email} renewed. Expires: ${user.subscriptionExpiresAt.toISOString()}`,
      );
    } else {
      // ─── First-time user (Scenario 1) ───
      this.logger.log(`First-time user payment. Triggering Enfonica flow for ${user.email}`);

      // Set hasPaid immediately so even if Enfonica fails, we know they paid
      user.hasPaid = true;
      user.lastPaymentDate = new Date();
      await user.save();

      // Provision the phone number, create DID, map tradie
      await this.enfonicaService.provisionFirstTimeDid(userId);
    }
  }

  // ─── Cron: Auto-Expiry ──────────────────────────────────────────────

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleSubscriptionAutoExpiry() {
    this.logger.log('Running daily subscription auto-expiry check...');
    const now = new Date();

    // Find users where subscriptionExpiresAt < now AND hasPaid = true
    const expiredUsers = await this.userModel
      .find({
        hasPaid: true,
        subscriptionExpiresAt: { $lt: now },
      })
      .exec();

    for (const user of expiredUsers) {
      try {
        const did = await this.didModel
          .findOne({ companyId: String(user._id) })
          .exec();

        if (did) {
          // unmapDid moves assignedTradieIds → unassignedTradieIds, sets hasPaid = false
          await this.adminService.unmapDid(String(did._id));
        } else {
          this.logger.warn(`Expired user ${user._id} has no DID record to unmap.`);
          user.hasPaid = false;
          await user.save();
        }

        this.logger.log(
          `Subscription expired for user ${user._id} (${user.email}) (number: ${user.phoneNumber || 'unknown'})`,
        );
      } catch (err: any) {
        this.logger.error(
          `Failed to process expiry for user ${user._id}: ${err.message}`,
          err.stack,
        );
      }
    }

    this.logger.log(`Completed auto-expiry check. Processed ${expiredUsers.length} users.`);
  }

  // ─── User Lookup ────────────────────────────────────────────────────

  private async findUserByStripeInfo(
    customerId: string,
    email?: string,
    clientReferenceId?: string,
  ) {
    const conditions: any[] = [{ stripeCustomerId: customerId }];

    if (email) {
      conditions.push({ email });
    }

    if (clientReferenceId) {
      conditions.unshift({ _id: clientReferenceId });
    }

    return this.userModel.findOne({ $or: conditions }).exec();
  }
}
