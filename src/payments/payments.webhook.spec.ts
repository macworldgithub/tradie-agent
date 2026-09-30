jest.mock('uuid', () => ({
  v4: () => '10000000-0000-4000-8000-000000000000',
}));

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import { BadRequestException } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { User } from '../auth/schemas/user.schema';
import { Did } from '../dids/schemas/did.schema';
import { ProcessedPayment } from './schemas/processed-payment.schema';
import { Tradie } from '../tradies/schemas/tradie.schema';
import { AdminService } from '../admin/admin.service';
import { EnfonicaService } from '../enfonica/enfonica.service';
import { MailService } from '../common/mail/mail.service';
import { NumberPortingService } from '../number-porting/number-porting.service';
import Stripe from 'stripe';

describe('Payments Webhook Verification & Handling', () => {
  const TEST_WEBHOOK_SECRET = 'whsec_test_secret_key_1234567890abcdef';
  const TEST_STRIPE_SECRET = 'sk_test_mock_stripe_key';

  let paymentsService: PaymentsService;
  let paymentsController: PaymentsController;
  let stripeClient: Stripe.Stripe;

  const mockUserModel = {
    findOne: jest.fn(),
    findById: jest.fn(),
    findByIdAndUpdate: jest.fn(),
  };

  const mockDidModel = {
    findOne: jest.fn(),
    findById: jest.fn(),
  };

  const mockProcessedPaymentModel = {
    create: jest.fn(),
  };

  const mockTradieModel = {
    findOne: jest.fn(),
    find: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn((key: string): string | null => {
      if (key === 'STRIPE_SECRET_KEY') return TEST_STRIPE_SECRET;
      if (key === 'STRIPE_WEBHOOK_SECRET') return `  ${TEST_WEBHOOK_SECRET}  \n`; // Test with whitespace
      return null;
    }),
  };

  const mockAdminService = {
    renewDid: jest.fn(),
    remapDid: jest.fn(),
    unmapDid: jest.fn(),
  };

  const mockEnfonicaService = {
    provisionFirstTimeDid: jest.fn(),
  };

  const mockMailService = {
    sendCallForwardingInstructionsEmail: jest.fn(),
  };

  const mockNumberPortingService = {
    isCompanyPorting: jest.fn(),
  };

  beforeAll(() => {
    stripeClient = new Stripe(TEST_STRIPE_SECRET, {
      apiVersion: '2026-05-27.dahlia',
    });
  });

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentsController],
      providers: [
        PaymentsService,
        { provide: getModelToken(User.name), useValue: mockUserModel },
        { provide: getModelToken(Did.name), useValue: mockDidModel },
        {
          provide: getModelToken(ProcessedPayment.name),
          useValue: mockProcessedPaymentModel,
        },
        { provide: getModelToken(Tradie.name), useValue: mockTradieModel },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: AdminService, useValue: mockAdminService },
        { provide: EnfonicaService, useValue: mockEnfonicaService },
        { provide: MailService, useValue: mockMailService },
        { provide: NumberPortingService, useValue: mockNumberPortingService },
      ],
    }).compile();

    paymentsService = module.get<PaymentsService>(PaymentsService);
    paymentsController = module.get<PaymentsController>(PaymentsController);
  });

  describe('PaymentsController.handleWebhook', () => {
    it('should throw BadRequestException if req.rawBody is missing', async () => {
      const mockReq: any = {
        headers: { 'stripe-signature': 't=123,v1=abc' },
        rawBody: undefined,
      };
      const mockRes: any = {
        status: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      await expect(
        paymentsController.handleWebhook(mockReq, mockRes),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if req.rawBody is not a Buffer', async () => {
      const mockReq: any = {
        headers: { 'stripe-signature': 't=123,v1=abc' },
        rawBody: '{"some":"json"}', // string instead of Buffer
      };
      const mockRes: any = {
        status: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      await expect(
        paymentsController.handleWebhook(mockReq, mockRes),
      ).rejects.toThrow(BadRequestException);
    });

    it('should pass signature and rawBody Buffer to PaymentsService and respond with 200', async () => {
      const rawBody = Buffer.from(JSON.stringify({ id: 'evt_test' }));
      const signature = 't=123,v1=valid_sig';
      const mockReq: any = {
        headers: { 'stripe-signature': signature },
        rawBody,
      };
      const mockRes: any = {
        status: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      jest
        .spyOn(paymentsService, 'handleWebhook')
        .mockResolvedValueOnce(undefined);

      await paymentsController.handleWebhook(mockReq, mockRes);

      expect(paymentsService.handleWebhook).toHaveBeenCalledWith(
        signature,
        rawBody,
      );
      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.send).toHaveBeenCalled();
    });

    it('should return 400 when PaymentsService throws an error', async () => {
      const rawBody = Buffer.from('payload');
      const mockReq: any = {
        headers: { 'stripe-signature': 'sig' },
        rawBody,
      };
      const mockRes: any = {
        status: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      jest
        .spyOn(paymentsService, 'handleWebhook')
        .mockRejectedValueOnce(new Error('Signature verification failed'));

      await paymentsController.handleWebhook(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.send).toHaveBeenCalledWith(
        'Webhook Error: Signature verification failed',
      );
    });
  });

  describe('PaymentsService.handleWebhook Signature Verification', () => {
    it('should throw BadRequestException if stripe-signature is missing', async () => {
      const payload = Buffer.from(JSON.stringify({ id: 'evt_test' }));

      await expect(
        paymentsService.handleWebhook('', payload),
      ).rejects.toThrow(BadRequestException);
      await expect(
        paymentsService.handleWebhook(undefined as any, payload),
      ).rejects.toThrow('Missing stripe-signature header');
    });

    it('should throw BadRequestException if STRIPE_WEBHOOK_SECRET is not configured', async () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'STRIPE_SECRET_KEY') return TEST_STRIPE_SECRET;
        if (key === 'STRIPE_WEBHOOK_SECRET') return null;
        return null;
      });

      const payload = Buffer.from(JSON.stringify({ id: 'evt_test' }));

      await expect(
        paymentsService.handleWebhook('t=123,v1=sig', payload),
      ).rejects.toThrow('Stripe webhook secret not configured');
    });

    it('should fail with Stripe Signature Verification Failed when signature is invalid', async () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'STRIPE_SECRET_KEY') return TEST_STRIPE_SECRET;
        if (key === 'STRIPE_WEBHOOK_SECRET') return TEST_WEBHOOK_SECRET;
        return null;
      });

      const payload = Buffer.from(
        JSON.stringify({
          id: 'evt_test',
          type: 'invoice.paid',
        }),
      );
      const invalidSignature =
        't=1700000000,v1=0000000000000000000000000000000000000000000000000000000000000000';

      await expect(
        paymentsService.handleWebhook(invalidSignature, payload),
      ).rejects.toThrow(/Stripe Signature Verification Failed/);
    });

    it('should fail when payload is tampered/corrupted after signature generation', async () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'STRIPE_SECRET_KEY') return TEST_STRIPE_SECRET;
        if (key === 'STRIPE_WEBHOOK_SECRET') return TEST_WEBHOOK_SECRET;
        return null;
      });

      const originalPayload = JSON.stringify({
        id: 'evt_test',
        type: 'invoice.paid',
      });
      const validSignature = stripeClient.webhooks.generateTestHeaderString({
        payload: originalPayload,
        secret: TEST_WEBHOOK_SECRET,
      });

      // Tampered payload
      const tamperedPayload = Buffer.from(
        JSON.stringify({
          id: 'evt_test',
          type: 'invoice.paid',
          tampered: true,
        }),
      );

      await expect(
        paymentsService.handleWebhook(validSignature, tamperedPayload),
      ).rejects.toThrow(/Stripe Signature Verification Failed/);
    });

    it('should successfully verify valid signature and process event (even with whitespace in webhook secret)', async () => {
      // Secret in config has leading/trailing whitespace which handleWebhook trims
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'STRIPE_SECRET_KEY') return TEST_STRIPE_SECRET;
        if (key === 'STRIPE_WEBHOOK_SECRET')
          return `  ${TEST_WEBHOOK_SECRET}  \n`;
        return null;
      });

      const payloadString = JSON.stringify({
        id: 'evt_test_success',
        object: 'event',
        type: 'customer.subscription.deleted',
        data: {
          object: {
            id: 'sub_123',
            customer: 'cus_123',
          },
        },
      });

      const validSignature = stripeClient.webhooks.generateTestHeaderString({
        payload: payloadString,
        secret: TEST_WEBHOOK_SECRET,
      });

      const payloadBuffer = Buffer.from(payloadString, 'utf-8');

      // Mock userModel for handleSubscriptionCancelled
      mockUserModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(null), // Customer not found is handled gracefully
      });

      await expect(
        paymentsService.handleWebhook(validSignature, payloadBuffer),
      ).resolves.not.toThrow();
    });
  });
});
