import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CallLog, CallLogDocument } from './schemas/call-log.schema';

@Injectable()
export class CallsService {
  constructor(
    @InjectModel(CallLog.name) private callLogModel: Model<CallLogDocument>,
  ) {}

  async create(log: Partial<CallLog>) {
    const created = new this.callLogModel(log);
    return created.save();
  }

  async findRecentByCaller(callerNumber: string, limit = 10) {
    return this.callLogModel
      .find({ callerNumber })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
      .exec();
  }
}
