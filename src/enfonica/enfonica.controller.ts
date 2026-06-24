import { Controller, Post, Param } from '@nestjs/common';
import { EnfonicaService } from './enfonica.service';

@Controller('enfonica')
export class EnfonicaController {
  constructor(private readonly enfonicaService: EnfonicaService) {}

  @Post('provision/:companyId')
  async provisionNumber(@Param('companyId') companyId: string) {
    const result = await this.enfonicaService.provisionNumber(companyId);
    return { success: true, number: result };
  }
}
