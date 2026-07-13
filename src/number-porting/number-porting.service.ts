import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { NumberPorting, NumberPortingDocument } from './schemas/number-porting.schema';

@Injectable()
export class NumberPortingService {
  constructor(
    @InjectModel(NumberPorting.name)
    private numberPortingModel: Model<NumberPortingDocument>,
  ) {}

  /**
   * Helper function to check if a company is currently porting a number.
   * Useful during the payment/provisioning step to skip new number allocation.
   */
  async isCompanyPorting(companyId: string): Promise<boolean> {
    const portingRecord = await this.numberPortingModel.findOne({ companyId }).exec();
    return portingRecord?.porting === true;
  }

  /**
   * Retrieves the document path for a porting record.
   * Ensures the requester is either the company owner or an admin.
   */
  async getDocumentPath(id: string, user: any): Promise<string> {
    const query: any = { _id: id };
    
    // If not an admin, restrict to their own company
    if (user.role !== 'admin') {
      query.companyId = user.companyId || user.sub;
    }

    const record = await this.numberPortingModel.findOne(query).exec();
    
    if (!record || !record.supportingDocumentPath) {
      throw new NotFoundException('Document not found');
    }
    
    return record.supportingDocumentPath;
  }
}
