import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Did, DidDocument } from './schemas/did.schema';

@Injectable()
export class DidsService {
  constructor(@InjectModel(Did.name) private didModel: Model<DidDocument>) {}

  async findByDidNumber(didNumber: string): Promise<Did | null> {
    return this.didModel.findOne({ didNumber }).lean().exec();
  }

  async findById(id: string): Promise<Did | null> {
    return this.didModel.findById(id).lean().exec();
  }

  async ensureActive(didNumber: string): Promise<boolean> {
    const d = await this.didModel
      .findOne({ didNumber, isActive: true })
      .lean()
      .exec();
    return !!d;
  }
}
