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

    const did = await this.didModel.findOne({ companyId }).lean().exec();
    const tradies = await this.tradieModel.find({ companyId }).lean().exec();

    let daysRemaining = 0;
    if (did?.subscriptionStartDate) {
      daysRemaining = Math.max(0, 30 - this.daysSince(did.subscriptionStartDate));
    }

    return {
      company,
      did,
      tradies,
      daysRemaining
    };
  }

  async createTradie(companyId: string, dto: CreateTradieDto) {
    return this.tradiesService.create({ ...dto, companyId });
  }

  async createDid(companyId: string, dto: { didNumber: string, tradieIds?: string[] }) {
    const { didNumber, tradieIds = [] } = dto;

    await this.didsService.validateTradieAssignments(undefined, tradieIds, companyId);

    const did = new this.didModel({
      didNumber,
      companyId,
      assignedTradieIds: tradieIds,
      subscriptionStartDate: new Date()
    });

    try {
      await did.save();
    } catch (e) {
      if (e.code === 11000) throw new BadRequestException('DID already exists');
      throw e;
    }

    if (tradieIds.length > 0) {
      for (const id of tradieIds) {
        await this.tradiesService.updateIsMapped(id, true);
      }
    }

    return did;
  }

  async mapTradieToDid(didId: string, tradieId: string) {
    const did = await this.didModel.findById(didId).exec();
    if (!did) throw new NotFoundException('DID not found');

    const newAssignedIds = [...(did.assignedTradieIds || [])];
    if (!newAssignedIds.includes(tradieId)) {
      newAssignedIds.push(tradieId);
    }
    await this.didsService.validateTradieAssignments(undefined, newAssignedIds, did.companyId);

    did.assignedTradieIds = newAssignedIds;
    await did.save();
    await this.tradiesService.updateIsMapped(tradieId, true);

    return did;
  }

  async unmapDid(didId: string) {
    const did = await this.didModel.findById(didId).exec();
    if (!did) throw new NotFoundException('DID not found');

    const prevTradies = did.assignedTradieIds || [];
    did.assignedTradieIds = [];
    await did.save();

    for (const id of prevTradies) {
      await this.tradiesService.updateIsMapped(String(id), false);
    }

    await this.userModel.findByIdAndUpdate(did.companyId, { hasPaid: false }).exec();
    return did;
  }

  async remapDid(didId: string, tradieIds: string[]) {
    const did = await this.didModel.findById(didId).exec();
    if (!did) throw new NotFoundException('DID not found');

    await this.didsService.validateTradieAssignments(undefined, tradieIds, did.companyId);

    const prevTradies = did.assignedTradieIds || [];
    did.assignedTradieIds = tradieIds;
    did.subscriptionStartDate = new Date();
    await did.save();

    for (const id of prevTradies) {
      if (!tradieIds.includes(String(id))) {
        await this.tradiesService.updateIsMapped(String(id), false);
      }
    }

    for (const id of tradieIds) {
      await this.tradiesService.updateIsMapped(String(id), true);
    }

    await this.userModel.findByIdAndUpdate(did.companyId, { hasPaid: true }).exec();

    return did;
  }
}
