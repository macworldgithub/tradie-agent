import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { NotificationService } from '../common/notification.service';
import { SendTestSmsDto } from './dtos/send-test-sms.dto';

@ApiTags('SMS Test')
@Controller('sms-test')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class SmsTestController {
  constructor(private readonly notificationService: NotificationService) {}

  @Post('send')
  @ApiOperation({ summary: 'Send a test SMS via MobileMessage API' })
  @ApiBody({ type: SendTestSmsDto })
  async sendTestSms(@Body() dto: SendTestSmsDto) {
    const rawResult = await this.notificationService.sendSms(dto.to, dto.message);
    const success = rawResult?.results?.[0]?.status === 'success';
    return { 
      success, 
      message: `Test SMS dispatched to ${dto.to}`,
      rawResult,
    };
  }
}
