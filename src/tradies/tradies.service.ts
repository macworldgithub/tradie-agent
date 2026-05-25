import { ConflictException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Tradie, TradieDocument } from './schemas/tradie.schema';
import { CreateTradieDto } from './dtos/create-tradie.dto';
import { UpdateTradieDto } from './dtos/update-tradie.dto';

@Injectable()
export class TradiesService {
  constructor(
    @InjectModel(Tradie.name) private tradieModel: Model<TradieDocument>,
  ) {}

  async create(dto: CreateTradieDto & { companyId: string }): Promise<Tradie> {
    const existing = await this.tradieModel
      .findOne({ companyId: dto.companyId })
      .lean()
      .exec();
    if (existing) {
      throw new ConflictException(
        'A tradie already exists for this company. One company can only have one tradie.',
      );
    }
    const created = new this.tradieModel(dto);
    return created.save();
  }

  async findAll(companyId: string): Promise<Tradie[]> {
    return this.tradieModel.find({ companyId }).lean().exec();
  }

  async findById(id: string): Promise<Tradie | null> {
    return this.tradieModel.findById(id).lean().exec();
  }

  async findByPhone(phoneNumber: string): Promise<Tradie | null> {
    return this.tradieModel.findOne({ phoneNumber }).lean().exec();
  }

  async update(id: string, dto: UpdateTradieDto): Promise<Tradie | null> {
    return this.tradieModel
      .findByIdAndUpdate(id, dto, { new: true, runValidators: true })
      .lean()
      .exec();
  }

  async softDelete(id: string): Promise<Tradie | null> {
    return this.tradieModel.findByIdAndDelete(id).lean().exec();
  }
}
