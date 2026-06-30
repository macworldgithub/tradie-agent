import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { User, UserDocument } from '../auth/schemas/user.schema';
import { Did, DidDocument } from '../dids/schemas/did.schema';
import { Tradie, TradieDocument } from '../tradies/schemas/tradie.schema';
import { TradiesService } from '../tradies/tradies.service';
import { DidsService } from '../dids/dids.service';
import { CreateTradieDto } from '../tradies/dtos/create-tradie.dto';
import { CreateAdminDidDto } from './dtos/create-admin-did.dto';

@Injectable()
export class AdminService {
  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    @InjectModel(Did.name) private didModel: Model<DidDocument>,
    @InjectModel(Tradie.name) private tradieModel: Model<TradieDocument>,
    private configService: ConfigService,
    private tradiesService: TradiesService,
    private didsService: DidsService,
  ) { }

  private daysSince(date?: Date): number {
    if (!date) return 30; // 30 minus 30 = 0 days remaining if no date
    const diff = new Date().getTime() - new Date(date).getTime();
    return Math.floor(diff / (1000 * 3600 * 24));
  }

  async getCompanies() {
    const adminEmail = this.configService.get<string>('SUPERR_ADMIN_EMAIL');
    const companies = await this.userModel.find({ email: { $ne: adminEmail } }).lean().exec();

    const results = await Promise.all(companies.map(async (company) => {
      const did = await this.didModel.findOne({ companyId: String(company._id) }).lean().exec();
      const tradieCount = await this.tradieModel.countDocuments({ companyId: String(company._id) }).exec();

      let daysRemaining = 0;
      if (did?.subscriptionStartDate) {
        daysRemaining = Math.max(0, 30 - this.daysSince(did.subscriptionStartDate));
      }

      return {
        companyId: company._id,
        companyName: company.companyName,
        email: company.email,
        hasPaid: company.hasPaid,
        daysRemaining,
        didNumber: did?.didNumber || null,
        isActive: did ? (did.assignedTradieIds && did.assignedTradieIds.length > 0) : false,
        tradieCount
      };
    }));

    return results;
  }

  async getCompanyDetails(companyId: string) {
    const company = await this.userModel.findById(companyId).lean().exec();
    if (!company) throw new NotFoundException('Company not found');

    let did = await this.didModel.findOne({ companyId }).exec();
    const tradies = await this.tradieModel.find({ companyId }).lean().exec();

    // Self-heal ghost IDs on read
    if (did && did.assignedTradieIds && did.assignedTradieIds.length > 0) {
      const existingIds = did.assignedTradieIds.map(String);
      const validTradieIds = tradies.map(t => String(t._id)); // We already fetched the company's tradies above
      
      const cleanIds = existingIds.filter(id => validTradieIds.includes(id));
      
      if (cleanIds.length !== existingIds.length) {
        // A ghost was found! Clean it up and save.
        did.assignedTradieIds = cleanIds;
        await did.save();
      }
    }

    let daysRemaining = 0;
    if (did?.subscriptionStartDate) {
      daysRemaining = Math.max(0, 30 - this.daysSince(did.subscriptionStartDate));
    }

    return {
      company,
      did: did ? did.toObject() : null,
      tradies,
      daysRemaining
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
      await this.didsService.validateTradieAssignments(undefined, [tradieId], companyId);

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
        if (e.code === 11000) throw new BadRequestException('DID number already in use.');
        throw e;
      }

      await this.tradiesService.updateIsMapped(tradieId, true);
      // TODO: Remove manual hasPaid and lastPaymentDate updates when Stripe is fully live
      await this.userModel.findByIdAndUpdate(companyId, { hasPaid: true, lastPaymentDate: new Date() }).exec();
      return did;
    }

    // DID already exists — self-heal by removing any ghost IDs, then append new tradieId
    const existingIds = (existing.assignedTradieIds || []).map(String);
    
    // Find which of those IDs actually still exist in the DB
    const validExistingTradies = await this.tradieModel.find({ _id: { $in: existingIds } }).select('_id').lean().exec();
    const validExistingIds = validExistingTradies.map(t => String(t._id));

    const combined = validExistingIds.includes(tradieId)
      ? validExistingIds
      : [...validExistingIds, tradieId];

    await this.didsService.validateTradieAssignments(undefined, combined, companyId);

    const updated = await this.didModel
      .findByIdAndUpdate(
        existing._id,
        { $set: { assignedTradieIds: combined } },
        { new: true, runValidators: true },
      )
      .exec();

    await this.tradiesService.updateIsMapped(tradieId, true);
    // TODO: Remove manual hasPaid and lastPaymentDate updates when Stripe is fully live
    await this.userModel.findByIdAndUpdate(companyId, { hasPaid: true, lastPaymentDate: new Date() }).exec();
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

    await this.tradiesService.updateManyIsMapped(prevTradies as string[], false);

    await this.userModel.findByIdAndUpdate(did.companyId, { hasPaid: false }).exec();
    return did;
  }

  async remapDid(didId: string) {
    const did = await this.didModel.findById(didId).exec();
    if (!did) throw new NotFoundException('DID not found');

    // Fetch the previously unassigned tradies
    const unassignedIds = did.unassignedTradieIds || [];

    // Self-heal: ensure none of them were deleted while the company was unmapped
    const validTradies = await this.tradieModel.find({ _id: { $in: unassignedIds } }).select('_id').lean().exec();
    const validIds = validTradies.map(t => String(t._id));

    // Validate the remaining valid tradies (Mobile checks, etc)
    await this.didsService.validateTradieAssignments(undefined, validIds, did.companyId);

    did.assignedTradieIds = validIds;
    did.unassignedTradieIds = [];
    did.subscriptionStartDate = new Date();
    await did.save();

    await this.tradiesService.updateManyIsMapped(validIds, true);

    // TODO: Remove manual hasPaid and lastPaymentDate updates when Stripe is fully live
    await this.userModel.findByIdAndUpdate(did.companyId, { hasPaid: true, lastPaymentDate: new Date() }).exec();

    return did;
  }

  async renewDid(didId: string) {
    const did = await this.didModel.findById(didId).exec();
    if (!did) throw new NotFoundException('DID not found');

    const currentStart = did.subscriptionStartDate || new Date();

    // Move subscriptionStartDate forward by 30 days
    // This adds 30 days to daysRemaining without resetting unused days
    did.subscriptionStartDate = new Date(new Date(currentStart).getTime() + (30 * 24 * 60 * 60 * 1000));

    // Calculate new daysRemaining to return in response
    const daysSince = Math.floor((Date.now() - did.subscriptionStartDate.getTime()) / (1000 * 60 * 60 * 24));
    const daysRemaining = Math.max(0, 30 - daysSince);

    await did.save();

    // TODO: Remove manual hasPaid and lastPaymentDate updates when Stripe is fully live
    await this.userModel.findByIdAndUpdate(did.companyId, { hasPaid: true, lastPaymentDate: new Date() }).exec();

    return {
      success: true,
      newSubscriptionStartDate: did.subscriptionStartDate,
      daysRemaining
    };
  }
}
