import { Controller, Get, Post, Body } from '@nestjs/common';
import { NotificationService } from './notification.service';

@Controller('notifications')
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  @Post('test')
  async testNotification() {
    return this.notificationService.sendTestNotification();
  }

  @Post('send')
  async sendNotification(@Body() data: {
    tradie: any;
    lead: any;
  }) {
    return this.notificationService.notifyTradie(data.tradie, data.lead);
  }
}
