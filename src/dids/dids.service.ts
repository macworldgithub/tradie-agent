import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Did, DidDocument } from './schemas/did.schema';
import { CreateDidDto } from './dtos/create-did.dto';
import { UpdateDidDto } from './dtos/update-did.dto';
import { Tradie, TradieDocument } from '../tradies/schemas/tradie.schema';
import { TradiesService } from '../tradies/tradies.service';

@Injectable()
export class DidsService {
  constructor(
    @InjectModel(Did.name) private didModel: Model<DidDocument>,
    @InjectModel(Tradie.name) private tradieModel: Model<TradieDocument>,
    private tradiesService: TradiesService,
  ) { }

  private daysSince(date?: Date): number {
    if (!date) return 30;
    const diff = new Date().getTime() - new Date(date).getTime();
    return Math.floor(diff / (1000 * 3600 * 24));
  }

  async getStatus(companyId: string) {
    const did = await this.didModel.findOne({ companyId }).lean().exec();
    if (!did) {
      return { didNumber: null, isActive: false, daysRemaining: 0, subscriptionStartDate: null };
    }
    const daysRemaining = did.subscriptionStartDate ? Math.max(0, 30 - this.daysSince(did.subscriptionStartDate)) : 0;
    return {
      didNumber: did.didNumber,
      isActive: did.assignedTradieIds && did.assignedTradieIds.length > 0,
      daysRemaining,
      subscriptionStartDate: did.subscriptionStartDate || null,
    };
  }

  public async validateTradieAssignments(
    assignedTradieId?: string,
    assignedTradieIds?: string[],
    companyId?: string,
  ): Promise<void> {
    const idsToValidate: string[] = [];
    if (assignedTradieId) {
      idsToValidate.push(assignedTradieId);
    }
    if (assignedTradieIds && assignedTradieIds.length > 0) {
      idsToValidate.push(...assignedTradieIds);
    }

    const uniqueIds = Array.from(new Set(idsToValidate));
    if (uniqueIds.length === 0) {
      return;
    }

    const tradies = await this.tradieModel
      .find({ _id: { $in: uniqueIds } })
      .lean()
      .exec();

    if (companyId) {
      for (const id of uniqueIds) {
        const t = tradies.find((tr) => String(tr._id) === id);
        if (!t) {
          throw new BadRequestException(`Tradie with ID ${id} not found.`);
        }
        if (t.companyId !== companyId) {
          throw new BadRequestException(
            'The tradie does not belong to this company.',
          );
        }
      }
    }

    const hasMobile = tradies.some((t) => t.callReceivedOn === 'mobile');
    if (hasMobile && uniqueIds.length > 1) {
      throw new BadRequestException(
        'Mobile tradies require a dedicated DID and cannot share it with other tradies',
      );
    }
  }

  async create(dto: CreateDidDto & { companyId: string }): Promise<Did> {
    await this.validateTradieAssignments(dto.assignedTradieId, dto.assignedTradieIds, dto.companyId);

    const existing = await this.didModel
      .findOne({ companyId: dto.companyId })
      .lean()
      .exec();

    if (existing) {
      const existingAssignedIds = existing.assignedTradieIds || (existing.assignedTradieId ? [String(existing.assignedTradieId)] : []);
      const newAssignedIds = [...existingAssignedIds];

      if (dto.assignedTradieId && !newAssignedIds.includes(dto.assignedTradieId)) {
        newAssignedIds.push(dto.assignedTradieId);
      }

      await this.validateTradieAssignments(undefined, newAssignedIds, dto.companyId);

      const updateQuery: any = {};
      if (dto.assignedTradieId) {
        updateQuery.$addToSet = { assignedTradieIds: dto.assignedTradieId };
      }

      const updated = await this.didModel
        .findByIdAndUpdate(
          existing._id,
          Object.keys(updateQuery).length > 0 ? updateQuery : { $set: {} },
          { new: true, runValidators: true }
        )
        .populate('assignedTradieId', 'name phoneNumber email')
        .exec();

      if (dto.assignedTradieId) {
        await this.tradiesService.updateIsMapped(dto.assignedTradieId, true);
      }

      return updated as Did;
    }

    const assignedIds = dto.assignedTradieId ? [dto.assignedTradieId] : [];

    await this.validateTradieAssignments(dto.assignedTradieId, assignedIds, dto.companyId);

    try {
      const created = await new this.didModel({
        ...dto,
        assignedTradieIds: assignedIds,
      }).save();

      await created.populate('assignedTradieId', 'name phoneNumber email');

      if (dto.assignedTradieId) {
        await this.tradiesService.updateIsMapped(dto.assignedTradieId, true);
      }

      return created;
    } catch (error) {
      if (error.code === 11000) {
        throw new BadRequestException('This DID number is already registered to another account.');
      }
      throw error;
    }
  }

  async findAll(companyId: string): Promise<Did[]> {
    console.log("companyId", companyId);
    const dids = await this.didModel
      .find({ companyId })
      .populate('assignedTradieId', 'name phoneNumber email')
      .lean()
      .exec();
    console.log("dids", dids);

    return dids.map((did) => ({
      ...did,
      isFullyMapped: Boolean(
        did.didNumber && (did.assignedTradieId || (did.assignedTradieIds && did.assignedTradieIds.length > 0)),
      ),
    })) as Did[];
  }

  async findByDidNumber(didNumber: string): Promise<Did | null> {
    return this.didModel
      .findOne({ didNumber })
      .populate('assignedTradieId', 'name phoneNumber email')
      .lean()
      .exec();
  }

  async findById(id: string): Promise<Did | null> {
    const did = await this.didModel
      .findById(id)
      .populate('assignedTradieId', 'name phoneNumber email')
      .lean()
      .exec();

    if (!did) {
      return null;
    }

    return {
      ...did,
      isFullyMapped: Boolean(
        did.didNumber && (did.assignedTradieId || (did.assignedTradieIds && did.assignedTradieIds.length > 0)),
      ),
    } as Did;
  }

  async update(id: string, dto: UpdateDidDto): Promise<Did | null> {
    const existing = await this.didModel.findById(id).lean().exec();
    if (!existing) {
      throw new NotFoundException('DID not found');
    }

    const assignedTradieId = dto.assignedTradieId !== undefined ? dto.assignedTradieId : existing.assignedTradieId;
    const assignedTradieIds = dto.assignedTradieIds !== undefined ? dto.assignedTradieIds : existing.assignedTradieIds;

    await this.validateTradieAssignments(assignedTradieId, assignedTradieIds, existing.companyId);

    return this.didModel
      .findByIdAndUpdate(id, dto, { new: true, runValidators: true })
      .populate('assignedTradieId', 'name phoneNumber email')
      .lean()
      .exec();
  }

  async softDelete(id: string): Promise<Did | null> {
    return this.didModel
      .findByIdAndDelete(id)
      .populate('assignedTradieId', 'name phoneNumber email')
      .lean()
      .exec();
  }

  async removeTradie(companyId: string, tradieId: string): Promise<Did | null> {
    const existing = await this.didModel.findOne({ companyId }).lean().exec();
    if (!existing) {
      throw new NotFoundException('DID not found for this company');
    }

    const assignedTradieIds = existing.assignedTradieIds || [];
    const newAssignedIds = assignedTradieIds.filter(id => String(id) !== String(tradieId));

    const updateQuery: any = {
      $pull: { assignedTradieIds: tradieId }
    };

    if (existing.assignedTradieId && String(existing.assignedTradieId) === String(tradieId)) {
      updateQuery.$set = {
        assignedTradieId: newAssignedIds.length > 0 ? newAssignedIds[0] : null
      };
    }

    const updated = await this.didModel
      .findByIdAndUpdate(existing._id, updateQuery, { new: true, runValidators: true })
      .populate('assignedTradieId', 'name phoneNumber email')
      .lean()
      .exec();

    const stillExists = await this.didModel.findOne({ 
      assignedTradieIds: tradieId 
    }).lean().exec();

    if (!stillExists) {
      await this.tradiesService.updateIsMapped(tradieId, false);
    }

    return updated as Did;
  }

  async ensureActive(didNumber: string): Promise<boolean> {
    const d = await this.didModel
      .findOne({ didNumber })
      .lean()
      .exec();
    return !!d;
  }

  // async removeTradie(tradieId: string, companyId: string): Promise<void> {
  //   await this.didModel.updateMany(
  //     { companyId, assignedTradieIds: tradieId },
  //     { $pull: { assignedTradieIds: tradieId } }
  //   ).exec();

  //   const stillExists = await this.didModel.findOne({ assignedTradieIds: tradieId }).lean().exec();

  //   if (!stillExists) {
  //     await this.tradiesService.updateIsMapped(tradieId, false);
  //   }
  // }
}
