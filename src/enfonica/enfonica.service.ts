import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserDocument } from '../auth/schemas/user.schema';
import { Did, DidDocument } from '../dids/schemas/did.schema';
import { Tradie, TradieDocument } from '../tradies/schemas/tradie.schema';
import { AdminService } from '../admin/admin.service';
import { PhoneNumbersClient, PhoneNumberInstancesClient } from '@enfonica/numbering';
import { ConfigService } from '@nestjs/config';
import { getPrefixForCity, InvalidCityError, NoNumbersAvailableError } from '../config/au-city-prefixes';
import { BadRequestException } from '@nestjs/common';

const INCOMING_CALL_WEBHOOK = "https://tradie.omnisuiteai.com/webhook/call";

@Injectable()
export class EnfonicaService {
  private readonly logger = new Logger(EnfonicaService.name);
  private phoneNumbersClient = new PhoneNumbersClient();
  private phoneNumberInstancesClient = new PhoneNumberInstancesClient();

  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Did.name) private readonly didModel: Model<DidDocument>,
    @InjectModel(Tradie.name) private readonly tradieModel: Model<TradieDocument>,
    private readonly adminService: AdminService,
    private readonly configService: ConfigService,
  ) { }


  private getRegulatoryListing(countryCode: string): string {
    if (countryCode === 'AU') {
      const listing = process.env.ENFONICA_REGULATORY_LISTING_ID_AU;
      if (!listing) throw new Error('Missing env var: ENFONICA_REGULATORY_LISTING_ID_AU');
      return listing;
    }
    if (countryCode === 'NZ') {
      const listing = process.env.ENFONICA_REGULATORY_LISTING_ID_NZ;
      if (!listing) throw new Error('Missing env var: ENFONICA_REGULATORY_LISTING_ID_NZ');
      return listing;
    }
    throw new Error(`Unsupported country code for regulatory listing: ${countryCode}`);
  }

  async provisionFirstTimeDid(userId: string) {
    const user = await this.userModel.findById(userId);
    if (!user) throw new Error(`User ${userId} not found`);

    const existingDid = await this.didModel.findOne({ companyId: userId }).exec();
    if (user.phoneNumberInstanceName || existingDid) {
      this.logger.warn(`User ${userId} already has a number provisioned or DID exists. Skipping.`);
      return;
    }

    const country = user.country || 'AU';
    const cityCode = user.cityCode;

    if (!cityCode) {
      throw new BadRequestException('City code is missing for user');
    }

    let prefix: string;
    try {
      prefix = getPrefixForCity(cityCode);
    } catch (error) {
      if (error instanceof InvalidCityError) {
        throw new BadRequestException('INVALID_CITY');
      }
      throw error;
    }

    // 2a. Search phone numbers
    const [numbers] = await this.phoneNumbersClient.searchPhoneNumbers({
      countryCode: country,
      numberType: 'LOCAL',
      prefix
    });

    if (!numbers || numbers.length === 0) {
      throw new BadRequestException(`No numbers currently available for ${user.cityName || cityCode}, please try again shortly or pick another city`);
    }

    const selectedNumber = numbers[0];

    // 2b. Purchase number
    let instanceName: string;
    let phoneNumberString: string;

    const parent = `projects/${process.env.ENFONICA_PROJECT_ID}`;

    try {
      const response = await this.phoneNumberInstancesClient.createPhoneNumberInstance({
        parent,
        phoneNumberInstance: {
          phoneNumber: { name: selectedNumber.name },
          regulatoryListing: this.getRegulatoryListing(country)
        }
      } as any);

      const instance = response[0];
      if (!instance.name) {
        throw new Error('Instance name is missing from Enfonica response');
      }
      instanceName = instance.name;
      phoneNumberString = instance.phoneNumber?.phoneNumber || (selectedNumber as any).phoneNumber;

      if (instance.lifecycleState !== 'ACTIVE') {
        this.logger.warn(`Number lifecycleState is not ACTIVE: ${instance.lifecycleState}`);
      }
    } catch (err: any) {
      this.logger.error(`Error purchasing Enfonica number for user ${userId}`, err.stack || err);

      // const isProd = this.configService.get<string>('NODE_ENV') === 'production';
      // if (!isProd) {
      //   this.logger.warn(`[LOCAL/DEV FALLBACK] Enfonica number purchase failed or not configured. Generating a mock number...`);
      //   instanceName = `projects/mock-project/phoneNumberInstances/mock-${Date.now()}`;
      //   phoneNumberString = `+6129${Math.floor(1000000 + Math.random() * 9000000)}`;
      // } else {
      throw err;
      // }
    }

    // Wrap steps 2c to 7 in try/catch to log if setup fails after purchase
    try {
      // 2c. Immediately set incoming call webhook (mandatory)
      const incomingCallWebhook = this.configService.get<string>('INCOMING_CALL_WEBHOOK') || INCOMING_CALL_WEBHOOK;
      await this.phoneNumberInstancesClient.updatePhoneNumberInstance({
        name: instanceName,
        phoneNumberInstance: {
          incomingCallHandlerUris: [incomingCallWebhook],
        },
        updateMask: {
          paths: ['incoming_call_handler_uris'],
        },
      } as any);

      // 3 & 4. Assign DID to company and trigger tradie mapping
      const firstTradie = await this.tradieModel.findOne({ companyId: userId });
      if (firstTradie) {
        await this.adminService.createDid(userId, {
          didNumber: phoneNumberString,
          tradieId: String(firstTradie._id),
        });
      } else {
        this.logger.warn(`No tradie found for company ${userId}, DID was not mapped in AdminService`);
      }

      // Save to user record
      const now = new Date();
      user.phoneNumberInstanceName = instanceName;
      user.phoneNumber = phoneNumberString;

      const currentExpiry = user.subscriptionExpiresAt ? new Date(user.subscriptionExpiresAt) : now;
      const baseDate = currentExpiry > now ? currentExpiry : now;
      user.subscriptionExpiresAt = new Date(baseDate.getTime() + (30 * 24 * 60 * 60 * 1000));

      await user.save();
    } catch (error: any) {
      this.logger.error(`FATAL: Enfonica number ${instanceName} was purchased but subsequent setup failed for user ${userId}`, error.stack || error);
      throw error;
    }
  }
}