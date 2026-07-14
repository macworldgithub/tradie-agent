import {
  Controller,
  Get,
  Param,
  Req,
  Res,
  UseGuards,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { NumberPortingService } from './number-porting.service';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import * as fs from 'fs';
import * as path from 'path';

@ApiTags('Number Porting')
@Controller('api/number-porting')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class NumberPortingController {
  constructor(private readonly numberPortingService: NumberPortingService) {}

  @Get(':id/document')
  @ApiOperation({
    summary: 'Download the supporting document for a porting request',
  })
  async getDocument(
    @Param('id') id: string,
    @Req() req: any,
    @Res() res: Response,
  ) {
    // Get the file path securely via the service
    const documentPath = await this.numberPortingService.getDocumentPath(
      id,
      req.user,
    );

    // Resolve absolute path to ensure safety
    const absolutePath = path.resolve(documentPath);

    if (!fs.existsSync(absolutePath)) {
      throw new NotFoundException('Document file is missing on the server');
    }

    // Determine content type (though we enforce PDF during upload)
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="supporting-document.pdf"`,
    );

    // Stream the file
    const fileStream = fs.createReadStream(absolutePath);
    fileStream.on('error', (error) => {
      throw new InternalServerErrorException('Error streaming the file');
    });

    fileStream.pipe(res);
  }
}
