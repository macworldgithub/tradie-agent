import {
  Controller,
  Get,
  Param,
  Req,
  UseGuards,
  NotFoundException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { NumberPortingService } from './number-porting.service';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('Number Porting')
@Controller('api/number-porting')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class NumberPortingController {
  constructor(private readonly numberPortingService: NumberPortingService) {}

  @Get(':id/document')
  @ApiOperation({
    summary: 'Get the public URL for the supporting document',
  })
  async getDocument(
    @Param('id') id: string,
    @Req() req: any,
  ) {
    // Get the public URL for the document
    const documentUrl = await this.numberPortingService.getDocumentPath(
      id,
      req.user,
    );

    return {
      numberPortingDocument: documentUrl,
    };
  }
}
