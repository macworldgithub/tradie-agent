import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Tradie, TradieDocument } from './schemas/tradie.schema';

@Injectable()
export class TradiesService {
  constructor(
    @InjectModel(Tradie.name) private tradieModel: Model<TradieDocument>,
  ) {}

  async findById(id: string): Promise<Tradie | null> {
    return this.tradieModel.findById(id).lean().exec();
  }

  async findByPhone(phoneNumber: string): Promise<Tradie | null> {
    return this.tradieModel.findOne({ phoneNumber }).lean().exec();
  }
}
