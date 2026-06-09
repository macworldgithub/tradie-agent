import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CallLog, CallLogDocument } from './schemas/call-log.schema';

@Injectable()
export class CallsService {
  constructor(
    @InjectModel(CallLog.name) private callLogModel: Model<CallLogDocument>,
  ) { }

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

  async updateCallStatus(
    enfonicaCallId: string,
    status: 'initiated' | 'no_answer' | 'completed',
  ): Promise<void> {
    await this.callLogModel
      .findOneAndUpdate({ enfonicaCallId }, { status }, { new: false })
      .exec();
  }

  async updateCallSummary(
    enfonicaCallId: string,
    summary: Record<string, any>,
  ): Promise<void> {
    await this.callLogModel
      .findOneAndUpdate(
        { enfonicaCallId },
        { summary, status: 'completed' },
        { new: false },
      )
      .exec();
  }

  async findByEnfonicaCallId(enfonicaCallId: string): Promise<CallLog | null> {
    return this.callLogModel.findOne({ enfonicaCallId }).lean().exec();
  }
}
