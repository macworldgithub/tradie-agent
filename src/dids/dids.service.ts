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

@Injectable()
export class DidsService {
  constructor(
    @InjectModel(Did.name) private didModel: Model<DidDocument>,
    @InjectModel(Tradie.name) private tradieModel: Model<TradieDocument>,
  ) { }

  async create(dto: CreateDidDto & { companyId: string }): Promise<Did> {
    const existing = await this.didModel
      .findOne({ companyId: dto.companyId })
      .lean()
      .exec();
    if (existing) {
      throw new ConflictException(
        'A DID already exists for this company. One company can only have one DID.',
      );
    }

    const tradie = await this.tradieModel
      .findById(dto.assignedTradieId)
      .lean()
      .exec();
    if (!tradie || tradie.companyId !== dto.companyId) {
      throw new BadRequestException(
        'The tradie does not belong to this company.',
      );
    }

    const created = await new this.didModel(dto).save();
    await created.populate('assignedTradieId', 'name phoneNumber email');
    return created;
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
        did.didNumber && did.assignedTradieId && did.tradieNumber,
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
        did.didNumber && did.assignedTradieId && did.tradieNumber,
      ),
    } as Did;
  }

  async update(id: string, dto: UpdateDidDto): Promise<Did | null> {
    return this.didModel
      .findByIdAndUpdate(id, dto, { new: true, runValidators: true })
      .populate('assignedTradieId', 'name phoneNumber email')
      .lean()
      .exec();
  }

  async softDelete(id: string): Promise<Did | null> {
    return this.didModel
      .findByIdAndUpdate(
        id,
        { isActive: false },
        { new: true, runValidators: true },
      )
      .populate('assignedTradieId', 'name phoneNumber email')
      .lean()
      .exec();
  }

  async ensureActive(didNumber: string): Promise<boolean> {
    const d = await this.didModel
      .findOne({ didNumber, isActive: true })
      .lean()
      .exec();
    return !!d;
  }
}
