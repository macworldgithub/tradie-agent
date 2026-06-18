import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { DidsService } from './dids.service';
import { CreateDidDto } from './dtos/create-did.dto';
import { UpdateDidDto } from './dtos/update-did.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth } from '@nestjs/swagger';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
@Controller('dids')
export class DidsController {
  constructor(private readonly didsService: DidsService) { }

  @Post()
  @Roles('admin')
  create(@Request() req, @Body() dto: CreateDidDto) {
    if (!dto.didNumber) {
      throw new BadRequestException('didNumber is required');
    }
    const companyId = req.user?.companyId;
    return this.didsService.create({ ...dto, companyId });
  }

  @Get()
  findAll(@Request() req) {
    return this.didsService.findAll(req.user?.companyId);
  }

  @Get('status')
  async getStatus(@Request() req) {
    return this.didsService.getStatus(req.user?.companyId);
  }

  @Get('number/:didNumber')
  async findByDidNumber(@Param('didNumber') didNumber: string) {
    const did = await this.didsService.findByDidNumber(didNumber);
    if (!did) {
      throw new NotFoundException('DID not found');
    }
    return did;
  }

  @Get(':id')
  async findById(@Param('id') id: string) {
    const did = await this.didsService.findById(id);
    if (!did) {
      throw new NotFoundException('DID not found');
    }
    return did;
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateDidDto) {
    const did = await this.didsService.update(id, dto);
    if (!did) {
      throw new NotFoundException('DID not found');
    }
    return did;
  }

  @Delete('tradie/:tradieId')
  @Roles('admin')
  async removeTradie(@Request() req, @Param('tradieId') tradieId: string) {
    const companyId = req.user?.companyId;
    if (!companyId) {
      throw new BadRequestException('Company ID missing from token');
    }
    const did = await this.didsService.removeTradie(companyId, tradieId);
    if (!did) {
      throw new NotFoundException('DID not found');
    }
    return did;
  }

  @Delete(':id')
  async softDelete(@Param('id') id: string) {
    const did = await this.didsService.softDelete(id);
    if (!did) {
      throw new NotFoundException('DID not found');
    }
    return did;
  }

  // @Delete('tradie/:tradieId')
  // async removeTradie(@Request() req, @Param('tradieId') tradieId: string) {
  //   await this.didsService.removeTradie(tradieId, req.user?.companyId);
  //   return { success: true };
  // }
}
