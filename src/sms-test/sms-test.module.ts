import { Module } from '@nestjs/common';
import { SmsTestController } from './sms-test.controller';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [CommonModule],
  controllers: [SmsTestController],
})
export class SmsTestModule {}
