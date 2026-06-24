import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserDocument } from '../auth/schemas/user.schema';
import { Did, DidDocument } from '../dids/schemas/did.schema';
import { Tradie, TradieDocument } from '../tradies/schemas/tradie.schema';
import { PhoneNumbersClient, PhoneNumberInstancesClient } from '@enfonica/numbering';

@Injectable()
export class EnfonicaService {
  private readonly logger = new Logger(EnfonicaService.name);
  private phoneNumbersClient = new PhoneNumbersClient();
  private phoneNumberInstancesClient = new PhoneNumberInstancesClient();

  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Did.name) private readonly didModel: Model<DidDocument>,
    @InjectModel(Tradie.name) private readonly tradieModel: Model<TradieDocument>,
  ) {}

  async provisionNumber(companyId: string): Promise<string> {
    try {
      const company = await this.userModel.findById(companyId);
      if (!company) {
        throw new Error(`Company with ID ${companyId} not found`);
      }

      if (company.didProvisioned === true) {
        this.logger.log('Already provisioned, skipping');
        return company.enfonicaNumber || '';
      }

      const country = company.country || 'AU';

      const [numbers] = await this.phoneNumbersClient.searchPhoneNumbers({
        countryCode: country,
        numberType: 'LOCAL',
      });

      if (!numbers || numbers.length === 0) {
        throw new Error(`No numbers available for country: ${country}`);
      }

      const selectedNumber = numbers[0];
      const parent = `projects/${process.env.ENFONICA_PROJECT_ID}`;
      
      let instance: any;
      try {
        const response = await this.phoneNumberInstancesClient.createPhoneNumberInstance({
          parent,
          phoneNumberInstance: {
            phoneNumber: selectedNumber,
          }
        } as any);
        instance = response[0];
      } catch (err) {
        const response = await this.phoneNumberInstancesClient.createPhoneNumberInstance({
          parent,
          phoneNumber: selectedNumber,
        } as any);
        instance = response[0];
      }

      const instanceName = instance.name;
      const purchasedNumberString = instance.phoneNumber?.phoneNumber || (selectedNumber as any).phoneNumber;

      await this.phoneNumberInstancesClient.updatePhoneNumberInstance({
        phoneNumberInstance: {
          name: instanceName,
          incomingCallHandlerUris: ['https://tradie.omnisuiteai.com/webhook/call'],
          labels: { company_id: companyId },
        },
        updateMask: {
          paths: ['incoming_call_handler_uris', 'labels'],
        },
      } as any);

      company.enfonicaNumber = purchasedNumberString;
      company.enfonicaInstanceName = instanceName;
      company.didProvisioned = true;
      await company.save();

      // Find first tradie and map to DID
      const firstTradie = await this.tradieModel.findOne({ companyId });
      let assignedTradieIds: string[] = [];
      if (firstTradie) {
        assignedTradieIds.push(firstTradie._id.toString());
        firstTradie.isMapped = true;
        await firstTradie.save();
      }

      const didRecord = new this.didModel({
        didNumber: purchasedNumberString,
        companyId,
        assignedTradieIds,
      });
      await didRecord.save();


      return purchasedNumberString;
    } catch (error: any) {
      this.logger.error(`Error provisioning number for company ${companyId}`, error.stack || error);
      throw new InternalServerErrorException(`Failed to provision number: ${error.message}`);
    }
  }
}
