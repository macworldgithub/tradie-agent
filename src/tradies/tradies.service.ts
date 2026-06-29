import { ConflictException, Injectable, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Tradie, TradieDocument } from './schemas/tradie.schema';
import { Did, DidDocument } from '../dids/schemas/did.schema';
import { CreateTradieDto } from './dtos/create-tradie.dto';
import { UpdateTradieDto } from './dtos/update-tradie.dto';

@Injectable()
export class TradiesService {
  constructor(
    @InjectModel(Tradie.name) private tradieModel: Model<TradieDocument>,
    @InjectModel(Did.name) private didModel: Model<DidDocument>,
  ) {}

  async create(dto: CreateTradieDto & { companyId: string }): Promise<Tradie> {
    const created = new this.tradieModel(dto);
    return created.save();
  }

  async findAll(companyId: string): Promise<Tradie[]> {
    return this.tradieModel.find({ companyId }).lean().exec();
  }

  async findById(id: string): Promise<Tradie | null> {
    return this.tradieModel.findById(id).lean().exec();
  }

  async findByIds(ids: string[]): Promise<Tradie[]> {
    return this.tradieModel.find({ _id: { $in: ids } }).lean().exec();
  }

  async findByPhone(phoneNumber: string): Promise<Tradie | null> {
    return this.tradieModel.findOne({ phoneNumber }).lean().exec();
  }

  async update(id: string, dto: UpdateTradieDto): Promise<Tradie | null> {
    if (dto.callMode === 'ussd') {
      const assignedDids = await this.didModel
        .find({
          $or: [
            { assignedTradieId: id },
            { assignedTradieIds: id },
          ],
        })
        .lean()
        .exec();

      for (const did of assignedDids) {
        const uniqueTradieIds = new Set<string>();
        if (did.assignedTradieId) {
          uniqueTradieIds.add(String(did.assignedTradieId));
        }
        if (did.assignedTradieIds && did.assignedTradieIds.length > 0) {
          for (const tid of did.assignedTradieIds) {
            uniqueTradieIds.add(String(tid));
          }
        }

        if (uniqueTradieIds.size > 1) {
          throw new BadRequestException(
            'USSD tradies require a dedicated DID and cannot share it with other tradies',
          );
        }
      }
    }

    return this.tradieModel
      .findByIdAndUpdate(id, dto, { new: true, runValidators: true })
      .lean()
      .exec();
  }

  async softDelete(id: string): Promise<Tradie | null> {
    const deletedTradie = await this.tradieModel.findByIdAndDelete(id).lean().exec();
    if (deletedTradie) {
      // Remove from assigned AND unassigned arrays
      const affectedDids = await this.didModel.find({ 
        $or: [
          { assignedTradieIds: id },
          { assignedTradieIds: id.length === 24 ? new (require('mongoose').Types.ObjectId)(id) : id },
          { unassignedTradieIds: id },
          { unassignedTradieIds: id.length === 24 ? new (require('mongoose').Types.ObjectId)(id) : id }
        ]
      }).exec();

      for (const did of affectedDids) {
        if (did.assignedTradieIds) {
          did.assignedTradieIds = did.assignedTradieIds.filter(tid => String(tid) !== String(id));
        }
        if (did.unassignedTradieIds) {
          did.unassignedTradieIds = did.unassignedTradieIds.filter(tid => String(tid) !== String(id));
        }
        await did.save();
      }

      // If it was the primary legacy assignedTradieId, re-assign or unset
      const didsWithPrimary = await this.didModel.find({ assignedTradieId: id }).exec();
      for (const did of didsWithPrimary) {
        const remainingIds = (did.assignedTradieIds || []).filter(tid => String(tid) !== String(id));
        did.assignedTradieId = remainingIds.length > 0 ? remainingIds[0] as any : null;
        await did.save();
      }
    }
    return deletedTradie;
  }

  async updateIsMapped(tradieId: string, value: boolean): Promise<void> {
    await this.tradieModel.findByIdAndUpdate(tradieId, { isMapped: value }).exec();
  }

  async updateManyIsMapped(tradieIds: string[], value: boolean): Promise<void> {
    if (tradieIds.length === 0) return;
    await this.tradieModel.updateMany(
      { _id: { $in: tradieIds } },
      { $set: { isMapped: value } }
    ).exec();
  }
}
