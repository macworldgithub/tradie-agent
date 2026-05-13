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
import { TradiesService } from './tradies.service';
import { CreateTradieDto } from './dtos/create-tradie.dto';
import { UpdateTradieDto } from './dtos/update-tradie.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('tradies')
export class TradiesController {
  constructor(private readonly tradiesService: TradiesService) {}

  @Post()
  create(@Request() req, @Body() dto: CreateTradieDto) {
    if (!dto.name || !dto.phoneNumber) {
      throw new BadRequestException('name and phoneNumber are required');
    }
    const companyId = req.user?.companyId;
    return this.tradiesService.create({ ...dto, companyId });
  }

  @Get()
  findAll(@Request() req) {
    return this.tradiesService.findAll(req.user?.companyId);
  }

  @Get('mine')
  async findMine(@Request() req) {
    const tradies = await this.tradiesService.findAll(req.user?.companyId);
    return tradies.map((tradie: any) => ({
      _id: tradie._id,
      name: tradie.name,
      phoneNumber: tradie.phoneNumber,
    }));
  }

  @Get(':id')
  async findById(@Param('id') id: string) {
    const tradie = await this.tradiesService.findById(id);
    if (!tradie) {
      throw new NotFoundException('Tradie not found');
    }
    return tradie;
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateTradieDto) {
    const tradie = await this.tradiesService.update(id, dto);
    if (!tradie) {
      throw new NotFoundException('Tradie not found');
    }
    return tradie;
  }

  @Delete(':id')
  async softDelete(@Param('id') id: string) {
    const tradie = await this.tradiesService.softDelete(id);
    if (!tradie) {
      throw new NotFoundException('Tradie not found');
    }
    return tradie;
  }
}
