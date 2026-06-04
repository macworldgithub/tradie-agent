import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { VoiceService } from './voice.service';
import { DidsService } from '../dids/dids.service';
import { TradiesService } from '../tradies/tradies.service';
import { SessionService } from '../session/session.service';
import { CallsService } from '../calls/calls.service';
import { AriRtpMediaService } from '../ari/ari-rtp-media.service';
import { CallEventEmitter } from './call-event-emitter';
import { Customer } from './Schema/customer.schema';

describe('VoiceService', () => {
  let service: VoiceService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VoiceService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn() },
        },
        {
          provide: getModelToken(Customer.name),
          useValue: {},
        },
        {
          provide: DidsService,
          useValue: { findByDidNumber: jest.fn() },
        },
        {
          provide: TradiesService,
          useValue: { findById: jest.fn() },
        },
        {
          provide: SessionService,
          useValue: {},
        },
        {
          provide: CallsService,
          useValue: {},
        },
        {
          provide: AriRtpMediaService,
          useValue: {},
        },
        {
          provide: CallEventEmitter,
          useValue: { emit: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<VoiceService>(VoiceService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
