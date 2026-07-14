import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { User, UserDocument } from '../auth/schemas/user.schema';
import { Did, DidDocument } from '../dids/schemas/did.schema';
import { Tradie, TradieDocument } from '../tradies/schemas/tradie.schema';
import { NumberPorting, NumberPortingDocument } from '../number-porting/schemas/number-porting.schema';
import { TradiesService } from '../tradies/tradies.service';
import { DidsService } from '../dids/dids.service';
import { CreateTradieDto } from '../tradies/dtos/create-tradie.dto';
import { CreateAdminDidDto } from './dtos/create-admin-did.dto';
import Stripe from 'stripe';

@Injectable()
export class AdminService {
  private stripe: any;

  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    @InjectModel(Did.name) private didModel: Model<DidDocument>,
    @InjectModel(Tradie.name) private tradieModel: Model<TradieDocument>,
    @InjectModel(NumberPorting.name) private numberPortingModel: Model<NumberPortingDocument>,
    private configService: ConfigService,
    private tradiesService: TradiesService,
    private didsService: DidsService,
  ) {
    const stripeKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    if (stripeKey) {
      this.stripe = new Stripe(stripeKey, { apiVersion: '2024-04-10' as any });
    }
  }

  private daysSince(date?: Date): number {
    if (!date) return 30; // 30 minus 30 = 0 days remaining if no date
    const diff = new Date().getTime() - new Date(date).getTime();
    return Math.floor(diff / (1000 * 3600 * 24));
  }

  async getCompanies() {
    const adminEmail = this.configService.get<string>('SUPERR_ADMIN_EMAIL');
    const companies = await this.userModel
      .find({ email: { $ne: adminEmail } })
      .lean()
      .exec();

    const results = await Promise.all(
      companies.map(async (company) => {
        const did = await this.didModel
          .findOne({ companyId: String(company._id) })
          .lean()
          .exec();
        const tradieCount = await this.tradieModel
          .countDocuments({ companyId: String(company._id) })
          .exec();

        // Use subscriptionExpiresAt (same field the cron checks) so daysRemaining is consistent
        let daysRemaining = 0;
        if ((company as any).subscriptionExpiresAt) {
          const msRemaining =
            new Date((company as any).subscriptionExpiresAt).getTime() -
            Date.now();
          daysRemaining = Math.max(
            0,
            Math.ceil(msRemaining / (1000 * 3600 * 24)),
          );
        } else if (did?.subscriptionStartDate) {
          // Fallback for legacy records that predate subscriptionExpiresAt
          daysRemaining = Math.max(
            0,
            30 - this.daysSince(did.subscriptionStartDate),
          );
        }

        return {
          companyId: company._id,
          companyName: company.companyName,
          email: company.email,
          hasPaid: company.hasPaid,
          daysRemaining,
          didNumber: did?.didNumber || null,
          isActive: did
            ? did.assignedTradieIds && did.assignedTradieIds.length > 0
            : false,
          tradieCount,
        };
      }),
    );

    return results;
  }

  async getCompanyDetails(companyId: string) {
    const company = await this.userModel.findById(companyId).lean().exec();
    if (!company) throw new NotFoundException('Company not found');

    const did = await this.didModel.findOne({ companyId }).exec();
    const tradies = await this.tradieModel.find({ companyId }).lean().exec();
    const portingInfo = await this.numberPortingModel.findOne({ companyId }).lean().exec();

    // Diagnostic: log if ghost IDs are detected (do NOT write on a GET — data mutations on reads cause silent data loss)
    if (did && did.assignedTradieIds && did.assignedTradieIds.length > 0) {
      const existingIds = did.assignedTradieIds.map(String);
      const validTradieIds = tradies.map((t) => String(t._id));
      const ghostIds = existingIds.filter((id) => !validTradieIds.includes(id));
      if (ghostIds.length > 0) {
        // Ghost detected — log only, do not mutate. Use the admin unmap/remap flow to clean up.
        console.warn(
          `[getCompanyDetails] Ghost tradie IDs detected in DID ${did._id}: ${ghostIds.join(', ')}`,
        );
      }
    }

    // Use subscriptionExpiresAt (same field the cron checks) so daysRemaining is consistent
    let daysRemaining = 0;
    if ((company as any).subscriptionExpiresAt) {
      const msRemaining =
        new Date((company as any).subscriptionExpiresAt).getTime() - Date.now();
      daysRemaining = Math.max(0, Math.ceil(msRemaining / (1000 * 3600 * 24)));
    } else if (did?.subscriptionStartDate) {
      // Fallback for legacy records that predate subscriptionExpiresAt
      daysRemaining = Math.max(
        0,
        30 - this.daysSince(did.subscriptionStartDate),
      );
    }

    return {
      company,
      did: did ? did.toObject() : null,
      tradies,
      daysRemaining,
      portingInfo,
    };
  }

  async deleteCompany(companyId: string) {
    const company = await this.userModel.findById(companyId).exec();
    if (!company) throw new NotFoundException('Company not found');

    await this.tradieModel.deleteMany({ companyId }).exec();
    await this.didModel.deleteMany({ companyId }).exec();
    await this.userModel.findByIdAndDelete(companyId).exec();

    return { success: true, message: 'Company and associated data deleted' };
  }

  async createTradie(companyId: string, dto: CreateTradieDto) {
    return this.tradiesService.create({ ...dto, companyId });
  }

  async createDid(companyId: string, dto: CreateAdminDidDto) {
    const { didNumber, tradieId } = dto;

    const existing = await this.didModel.findOne({ companyId }).exec();

    if (!existing) {
      // No DID yet — validate then create fresh
      await this.didsService.validateTradieAssignments(
        undefined,
        [tradieId],
        companyId,
      );

      const did = new this.didModel({
        didNumber,
        companyId,
        assignedTradieId: tradieId,
        assignedTradieIds: [tradieId],
        subscriptionStartDate: new Date(),
      });

      try {
        await did.save();
      } catch (e) {
        if (e.code === 11000)
          throw new BadRequestException('DID number already in use.');
        throw e;
      }

      await this.tradiesService.updateIsMapped(tradieId, true);
      
      // Start the official 30-day clock for the user now that they have a number
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

      const updatedCompany = await this.userModel
        .findByIdAndUpdate(companyId, {
          hasPaid: true,
          lastPaymentDate: now,
          subscriptionExpiresAt: expiresAt,
        }, { new: true })
        .exec();

      // If this is a porting customer, shift their Stripe billing cycle forward by 30 days
      // so their payment anniversary matches their true go-live date. Completely ignores Enfonica automated users.
      const isPorting = await this.numberPortingModel.findOne({ companyId, porting: true }).exec();
      if (isPorting && this.stripe && updatedCompany?.stripeSubscriptionId) {
        try {
          // To set the billing cycle to exactly 30 days from now, we need to create a new subscription
          // with the correct billing_cycle_anchor, then cancel the old one
          const subscription = await this.stripe.subscriptions.retrieve(updatedCompany.stripeSubscriptionId);
          
          // Create new subscription with billing cycle anchored to 30 days from now
          const newBillingDate = Math.floor(now.getTime() / 1000) + (30 * 24 * 60 * 60);
          const newSubscription = await this.stripe.subscriptions.create({
            customer: subscription.customer,
            items: subscription.items.data.map(item => ({
              price: item.price.id,
              quantity: item.quantity
            })),
            billing_cycle_anchor: newBillingDate,
            proration_behavior: 'none'
          });
          
          // Only cancel old subscription after new one is successfully created
          await this.stripe.subscriptions.cancel(updatedCompany.stripeSubscriptionId);
          
          // Update the company with the new subscription ID
          await this.userModel.findByIdAndUpdate(companyId, {
            stripeSubscriptionId: newSubscription.id
          }).exec();
          
          console.log(`[AdminService] Recreated Stripe subscription with billing cycle 30 days from now for porting company ${companyId}`);
        } catch (stripeErr: any) {
          console.error(`[AdminService] Failed to shift Stripe billing cycle for ${companyId}: ${stripeErr.message}`);
        }
      }

      return did;
    }

    // DID already exists — self-heal by removing any ghost IDs, then append new tradieId
    const existingIds = (existing.assignedTradieIds || []).map(String);

    // Find which of those IDs actually still exist in the DB
    const validExistingTradies = await this.tradieModel
      .find({ _id: { $in: existingIds } })
      .select('_id')
      .lean()
      .exec();
    const validExistingIds = validExistingTradies.map((t) => String(t._id));

    const combined = validExistingIds.includes(tradieId)
      ? validExistingIds
      : [...validExistingIds, tradieId];

    await this.didsService.validateTradieAssignments(
      undefined,
      combined,
      companyId,
    );

    const setQuery: any = { assignedTradieIds: combined };
    if (didNumber && didNumber !== existing.didNumber) {
      setQuery.didNumber = didNumber;
    }
    if (tradieId) {
      setQuery.assignedTradieId = tradieId;
    }

    let updated;
    try {
      updated = await this.didModel
        .findByIdAndUpdate(
          existing._id,
          { $set: setQuery },
          { new: true, runValidators: true },
        )
        .exec();
    } catch (e) {
      if (e.code === 11000)
        throw new BadRequestException('DID number already in use.');
      throw e;
    }

    await this.tradiesService.updateIsMapped(tradieId, true);
    // TODO: Remove manual hasPaid and lastPaymentDate updates when Stripe is fully live
    await this.userModel
      .findByIdAndUpdate(companyId, {
        hasPaid: true,
        lastPaymentDate: new Date(),
      })
      .exec();
    return updated;
  }

  async unmapDid(didId: string) {
    const did = await this.didModel.findById(didId).exec();
    if (!did) throw new NotFoundException('DID not found');

    const prevTradies = did.assignedTradieIds || [];

    // Store them in unassigned array for later restoration
    did.unassignedTradieIds = [...prevTradies];
    did.assignedTradieIds = [];
    await did.save();

    await this.tradiesService.updateManyIsMapped(prevTradies, false);

    await this.userModel
      .findByIdAndUpdate(did.companyId, { hasPaid: false })
      .exec();
    return did;
  }

  async remapDid(didId: string) {
    const did = await this.didModel.findById(didId).exec();
    if (!did) throw new NotFoundException('DID not found');

    // Fetch the previously unassigned tradies
    const unassignedIds = did.unassignedTradieIds || [];

    // Self-heal: ensure none of them were deleted while the company was unmapped
    const validTradies = await this.tradieModel
      .find({ _id: { $in: unassignedIds } })
      .select('_id')
      .lean()
      .exec();
    const validIds = validTradies.map((t) => String(t._id));

    // Validate the remaining valid tradies (Mobile checks, etc)
    await this.didsService.validateTradieAssignments(
      undefined,
      validIds,
      did.companyId,
    );

    did.assignedTradieIds = validIds;
    did.unassignedTradieIds = [];
    did.subscriptionStartDate = new Date();
    await did.save();

    await this.tradiesService.updateManyIsMapped(validIds, true);

    // TODO: Remove manual hasPaid and lastPaymentDate updates when Stripe is fully live
    await this.userModel
      .findByIdAndUpdate(did.companyId, {
        hasPaid: true,
        lastPaymentDate: new Date(),
      })
      .exec();

    return did;
  }

  async renewDid(didId: string) {
    const did = await this.didModel.findById(didId).exec();
    if (!did) throw new NotFoundException('DID not found');

    // Keep subscriptionStartDate in sync (legacy / display use)
    const currentStart = did.subscriptionStartDate || new Date();
    did.subscriptionStartDate = new Date(
      new Date(currentStart).getTime() + 30 * 24 * 60 * 60 * 1000,
    );
    await did.save();

    // Extend subscriptionExpiresAt on the user — this is the field the cron checks.
    // Stack 30 days onto whatever is remaining (or from now if already expired).
    const user = await this.userModel.findById(did.companyId).exec();
    if (user) {
      const now = new Date();
      const currentExpiry = user.subscriptionExpiresAt
        ? new Date(user.subscriptionExpiresAt)
        : now;
      const baseDate = currentExpiry > now ? currentExpiry : now;
      user.subscriptionExpiresAt = new Date(
        baseDate.getTime() + 30 * 24 * 60 * 60 * 1000,
      );
      user.hasPaid = true;
      user.lastPaymentDate = new Date();
      await user.save();

      const msRemaining = user.subscriptionExpiresAt.getTime() - now.getTime();
      const daysRemaining = Math.max(
        0,
        Math.ceil(msRemaining / (1000 * 3600 * 24)),
      );

      return {
        success: true,
        newSubscriptionExpiresAt: user.subscriptionExpiresAt,
        daysRemaining,
      };
    }

    return { success: true };
  }
}
