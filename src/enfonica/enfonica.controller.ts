import { Controller, Post, Param } from '@nestjs/common';
import { EnfonicaService } from './enfonica.service';

@Controller('enfonica')
export class EnfonicaController {
  constructor(private readonly enfonicaService: EnfonicaService) {}

  @Post('provision/:companyId')
  async provisionNumber(@Param('companyId') companyId: string) {
    await this.enfonicaService.provisionFirstTimeDid(companyId);
    return { success: true };
  }
}
