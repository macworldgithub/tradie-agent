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

  private async validateTradieAssignments(
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

    const hasUssd = tradies.some((t) => t.callMode === 'ussd');
    if (hasUssd && uniqueIds.length > 1) {
      throw new BadRequestException(
        'USSD tradies require a dedicated DID and cannot share it with other tradies',
      );
    }
  }

  async create(dto: CreateDidDto & { companyId: string }): Promise<Did> {
    await this.validateTradieAssignments(dto.assignedTradieId, dto.assignedTradieIds, dto.companyId);

    const existing = await this.didModel
      .findOne({ companyId: dto.companyId })
      .lean()
      .exec();

    let didResult: Did;

    if (existing) {
      // Append branch (DID already exists, $addToSet)
      const updatePayload: any = {};
      if (dto.assignedTradieId) {
        updatePayload.$addToSet = { assignedTradieIds: dto.assignedTradieId };
      }

      didResult = await this.didModel
        .findByIdAndUpdate(existing._id, updatePayload, { new: true })
        .populate('assignedTradieId', 'name phoneNumber email')
        .lean()
        .exec() as Did;
    } else {
      // Create-new-DID branch
      const created = await new this.didModel(dto).save();
      await created.populate('assignedTradieId', 'name phoneNumber email');
      didResult = created;
    }

    if (dto.assignedTradieId) {
      await this.tradiesService.updateIsMapped(dto.assignedTradieId, true);
    }

    return didResult;
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

  async ensureActive(didNumber: string): Promise<boolean> {
    const d = await this.didModel
      .findOne({ didNumber })
      .lean()
      .exec();
    return !!d;
  }

  async removeTradie(tradieId: string, companyId: string): Promise<void> {
    await this.didModel.updateMany(
      { companyId, assignedTradieIds: tradieId },
      { $pull: { assignedTradieIds: tradieId } }
    ).exec();

    const stillExists = await this.didModel.findOne({ assignedTradieIds: tradieId }).lean().exec();

    if (!stillExists) {
      await this.tradiesService.updateIsMapped(tradieId, false);
    }
  }
}
