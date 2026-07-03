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
import { ProcessedPayment, ProcessedPaymentDocument } from './schemas/processed-payment.schema';
import { MailService } from '../common/mail/mail.service';
import { Tradie, TradieDocument } from '../tradies/schemas/tradie.schema';

@Injectable()
export class PaymentsService {
  private stripe: any;
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    @InjectModel(Did.name) private didModel: Model<DidDocument>,
    @InjectModel(ProcessedPayment.name) private processedPaymentModel: Model<ProcessedPaymentDocument>,
    @InjectModel(Tradie.name) private tradieModel: Model<TradieDocument>,
    private configService: ConfigService,
    private adminService: AdminService,
    private enfonicaService: EnfonicaService,
    private mailService: MailService,
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

  async markAsProcessed(stripeId: string, companyId: string, eventType: string): Promise<boolean> {
    try {
      await this.processedPaymentModel.create({ stripeId, companyId, eventType });
      return true;
    } catch (err: any) {
      if (err.code === 11000) {
        return false;
      }
      throw err;
    }
  }

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
      success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl,
      client_reference_id: companyId,
    });

    return { url: session.url };
  }

  // ─── Sync Status By Session ID ──────────────────────────────────────

  async syncPaymentStatusBySessionId(sessionId: string) {
    if (!this.stripe) throw new BadRequestException('Stripe is not configured');

    const session = await this.stripe.checkout.sessions.retrieve(sessionId);
    if (!session) {
      throw new BadRequestException('Checkout session not found');
    }

    if (session.status !== 'complete' || session.payment_status !== 'paid') {
      this.logger.warn(`Checkout session ${sessionId} is not paid (status: ${session.status}, payment: ${session.payment_status})`);
      return { synced: false, message: 'Session is not paid' };
    }

    const customerId = session.customer as string;
    const email = session.customer_details?.email;
    const companyId = session.client_reference_id;

    const user = await this.findUserByStripeInfo(customerId, email, companyId);
    if (!user) {
      throw new BadRequestException(`User not found for Stripe customer ${customerId} / email ${email}`);
    }

    const wasMarked = await this.markAsProcessed(sessionId, String(user._id), 'checkout.session.completed');
    if (!wasMarked) {
      this.logger.log(`Checkout session ${sessionId} was already processed for user ${user.email}. Skipping redirect sync.`);
      return { synced: true, message: 'Session already processed', hasPaid: true };
    }

    // Save stripe IDs if not already saved
    if (customerId && !user.stripeCustomerId) {
      user.stripeCustomerId = customerId;
    }
    if (session.subscription) {
      user.stripeSubscriptionId = session.subscription as string;
    }

    await this.processSuccessfulPayment(user);
    this.logger.log(`Payment synced successfully via session redirect for user ${user.email}`);

    return { synced: true, hasPaid: true };
  }

  // ─── Webhook Entry Point ────────────────────────────────────────────

  async handleWebhook(signature: string, payload: Buffer) {
    this.logger.log('--- ENTERING PaymentsService.handleWebhook ---');
    if (!this.stripe) throw new BadRequestException('Stripe is not configured');

    const webhookSecret = this.configService.get<string>('STRIPE_WEBHOOK_SECRET');
    if (!webhookSecret)
      throw new BadRequestException('Stripe webhook secret not configured');

    let event: any;

    try {
      this.logger.log('Constructing Stripe Event from payload...');
      event = this.stripe.webhooks.constructEvent(payload, signature, webhookSecret);
      this.logger.log('✅ Stripe Event successfully constructed!');
    } catch (err) {
      this.logger.error(`❌ Webhook signature verification failed: ${err.message}`);
      throw new BadRequestException(`Webhook Error: ${err.message}`);
    }

    this.logger.log(`>>>>> Processing Stripe webhook event type: [ ${event.type} ] <<<<<`);

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
    this.logger.log(`--- ENTERING handleCheckoutCompleted for session ${session.id} ---`);
    const customerId = session.customer as string;
    const email = session.customer_details?.email;

    this.logger.log(`Looking up user for customerId: ${customerId}, email: ${email}, client_reference: ${session.client_reference_id}`);
    const user = await this.findUserByStripeInfo(customerId, email, session.client_reference_id);

    if (!user) {
      this.logger.warn(
        `❌ User not found for Stripe customer ${customerId} / email ${email}. Cannot process webhook further.`,
      );
      return;
    }

    this.logger.log(`✅ User found: ${user.email} (ID: ${user._id})`);

    // ── RETURNING USER GUARD ──────────────────────────────────────────────
    // For returning users (already have a DID provisioned), the renewal is
    // handled exclusively by invoice.paid. checkout.session.completed fires
    // alongside invoice.paid on every subscription renewal and would double-stack
    // days if we processed it here too. Only first-time users need this event.
    if (user.phoneNumberInstanceName) {
      this.logger.log(
        `Returning user ${user.email} — skipping checkout.session.completed (renewal handled by invoice.paid).`,
      );
      // IMPORTANT: Mark session as processed so syncPaymentStatusBySessionId
      // (triggered by the /payment-success redirect) cannot double-stack days.
      await this.markAsProcessed(session.id, String(user._id), 'checkout.session.completed');
      // Still save stripe IDs if missing
      let changed = false;
      if (customerId && !user.stripeCustomerId) { user.stripeCustomerId = customerId; changed = true; }
      if (session.subscription && !user.stripeSubscriptionId) { user.stripeSubscriptionId = session.subscription; changed = true; }
      if (changed) await user.save();
      return;
    }

    const wasMarked = await this.markAsProcessed(session.id, String(user._id), 'checkout.session.completed');
    if (!wasMarked) {
      this.logger.log(`Checkout session ${session.id} was already processed for user ${user.email}. Skipping webhook.`);
      return;
    }

    // Save stripe IDs immediately
    if (customerId && !user.stripeCustomerId) {
      user.stripeCustomerId = customerId;
    }
    if (session.subscription) {
      user.stripeSubscriptionId = session.subscription;
    }

    // Run first-time payment logic (Scenario 1 only)
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

    const wasMarked = await this.markAsProcessed(invoice.id, String(user._id), 'invoice.paid');
    if (!wasMarked) {
      this.logger.log(`Invoice ${invoice.id} was already processed for user ${user.email}. Skipping.`);
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

        // Always extend the DID subscription.
        // renewDid() handles extending user.subscriptionExpiresAt by 30 days (what the cron checks).
        const renewResult = await this.adminService.renewDid(String(did._id));
        this.logger.log(
          `Returning user ${user.email} renewed. Expires: ${renewResult?.newSubscriptionExpiresAt?.toISOString() ?? 'unknown'}`,
        );
      } else {
        this.logger.warn(`Returning user has no DID record to remap/renew: ${userId}`);
        // No DID to renew — at minimum mark as paid
        user.hasPaid = true;
        user.lastPaymentDate = new Date();
        await user.save();
      }
    } else {
      // ─── First-time user (Scenario 1) ───
      this.logger.log(`First-time user payment. Triggering Enfonica flow for ${user.email}`);

      // Set hasPaid immediately so even if Enfonica fails, we know they paid
      user.hasPaid = true;
      user.lastPaymentDate = new Date();
      await user.save();

      // Provision the phone number, create DID, map tradie
      await this.enfonicaService.provisionFirstTimeDid(userId);

      // Check if tradie has callReceivedOn set to 'mobile' to send forwarding instructions
      const tradie = await this.tradieModel.findOne({ companyId: userId }).exec();
      if (tradie && tradie.callReceivedOn === 'mobile') {
        const did = await this.didModel.findOne({ companyId: userId }).exec();
        if (did && did.didNumber) {
          this.logger.log(`Sending Call Forwarding Instructions Email to ${user.email}`);
          await this.mailService.sendCallForwardingInstructionsEmail(user.email, did.didNumber);
        }
      }
    }
  }

  // ─── Cron: Auto-Expiry ──────────────────────────────────────────────

  @Cron(CronExpression.EVERY_6_HOURS)
  async handleSubscriptionAutoExpiry() {
    this.logger.log('Running 6 Hours subscription auto-expiry check...');
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
