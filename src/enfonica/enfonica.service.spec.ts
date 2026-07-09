import { Test, TestingModule } from '@nestjs/testing';
import { EnfonicaService } from './enfonica.service';
import { getModelToken } from '@nestjs/mongoose';
import { AdminService } from '../admin/admin.service';
import { ConfigService } from '@nestjs/config';
import { User } from '../auth/schemas/user.schema';
import { Did } from '../dids/schemas/did.schema';
import { Tradie } from '../tradies/schemas/tradie.schema';
import { BadRequestException } from '@nestjs/common';
import * as EnfonicaNumbering from '@enfonica/numbering';

// Mock the Enfonica client classes
jest.mock('@enfonica/numbering', () => {
  return {
    PhoneNumbersClient: jest.fn().mockImplementation(() => ({
      searchPhoneNumbers: jest.fn(),
    })),
    PhoneNumberInstancesClient: jest.fn().mockImplementation(() => ({
      createPhoneNumberInstance: jest.fn(),
      updatePhoneNumberInstance: jest.fn(),
    })),
  };
});

describe('EnfonicaService', () => {
  let service: EnfonicaService;
  let mockUserModel: any;
  let mockDidModel: any;
  let mockTradieModel: any;
  let mockAdminService: any;
  let mockConfigService: any;
  let mockPhoneNumbersClient: any;
  let mockPhoneNumberInstancesClient: any;

  beforeEach(async () => {
    mockUserModel = {
      findById: jest.fn(),
    };
    mockDidModel = {
      findOne: jest.fn().mockReturnThis(),
      exec: jest.fn(),
    };
    mockTradieModel = {
      findOne: jest.fn(),
    };
    mockAdminService = {
      createDid: jest.fn(),
    };
    mockConfigService = {
      get: jest.fn().mockReturnValue('mock-webhook'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EnfonicaService,
        { provide: getModelToken(User.name), useValue: mockUserModel },
        { provide: getModelToken(Did.name), useValue: mockDidModel },
        { provide: getModelToken(Tradie.name), useValue: mockTradieModel },
        { provide: AdminService, useValue: mockAdminService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<EnfonicaService>(EnfonicaService);
    
    // Grab the mocked instances created inside the service
    mockPhoneNumbersClient = (service as any).phoneNumbersClient;
    mockPhoneNumberInstancesClient = (service as any).phoneNumberInstancesClient;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should purchase a number using the correct prefix for the selected city', async () => {
    const mockUser = {
      _id: 'user123',
      country: 'AU',
      cityCode: 'sydney',
      save: jest.fn(),
    };
    
    mockUserModel.findById.mockResolvedValue(mockUser);
    mockDidModel.exec.mockResolvedValue(null);
    mockTradieModel.findOne.mockResolvedValue({ _id: 'tradie123' });

    mockPhoneNumbersClient.searchPhoneNumbers.mockResolvedValue([
      [{ name: 'mock-number-name', phoneNumber: '+61272000000' }],
    ]);

    mockPhoneNumberInstancesClient.createPhoneNumberInstance.mockResolvedValue([
      { name: 'mock-instance-name', lifecycleState: 'ACTIVE', phoneNumber: { phoneNumber: '+61272000000' } },
    ]);

    // Mock environment variable
    process.env.ENFONICA_REGULATORY_LISTING_ID_AU = 'listing-au';
    process.env.ENFONICA_PROJECT_ID = 'project-123';

    await service.provisionFirstTimeDid('user123');

    // Assert search used the correct exact prefix string for 'sydney'
    expect(mockPhoneNumbersClient.searchPhoneNumbers).toHaveBeenCalledWith({
      countryCode: 'AU',
      numberType: 'LOCAL',
      prefix: '+61272', // sydney prefix
    });

    expect(mockPhoneNumberInstancesClient.createPhoneNumberInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        parent: 'projects/project-123',
      })
    );

    expect(mockUser.save).toHaveBeenCalled();
    expect((mockUser as any).phoneNumberInstanceName).toBe('mock-instance-name');
    expect((mockUser as any).phoneNumber).toBe('+61272000000');
    expect(mockAdminService.createDid).toHaveBeenCalledWith('user123', {
      didNumber: '+61272000000',
      tradieId: 'tradie123',
    });
  });

  it('should throw BadRequestException when no numbers are available', async () => {
    const mockUser = {
      _id: 'user123',
      country: 'AU',
      cityCode: 'sydney',
      cityName: 'Sydney',
    };
    
    mockUserModel.findById.mockResolvedValue(mockUser);
    mockDidModel.exec.mockResolvedValue(null);

    // Mock no results
    mockPhoneNumbersClient.searchPhoneNumbers.mockResolvedValue([[]]);

    await expect(service.provisionFirstTimeDid('user123')).rejects.toThrow(BadRequestException);
    await expect(service.provisionFirstTimeDid('user123')).rejects.toThrow('No numbers currently available for Sydney, please try again shortly or pick another city');
  });
});
