import { Controller, Get, Post, Delete, Param, Body, UseGuards } from '@nestjs/common';
import { AdminService } from './admin.service';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth } from '@nestjs/swagger';
import { CreateTradieDto } from '../tradies/dtos/create-tradie.dto';
import { CreateAdminDidDto } from './dtos/create-admin-did.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@ApiBearerAuth()
@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) { }

  @Get('companies')
  async getCompanies() {
    return this.adminService.getCompanies();
  }

  @Get('companies/:companyId')
  async getCompanyDetails(@Param('companyId') companyId: string) {
    return this.adminService.getCompanyDetails(companyId);
  }

  @Delete('companies/:companyId')
  async deleteCompany(@Param('companyId') companyId: string) {
    return this.adminService.deleteCompany(companyId);
  }

  @Post('companies/:companyId/tradies')
  async createTradie(@Param('companyId') companyId: string, @Body() dto: CreateTradieDto) {
    return this.adminService.createTradie(companyId, dto);
  }

  @Post('companies/:companyId/dids')
  async createDid(@Param('companyId') companyId: string, @Body() dto: CreateAdminDidDto) {
    return this.adminService.createDid(companyId, dto);
  }

  @Delete('dids/:didId/unmap')
  async unmapDid(@Param('didId') didId: string) {
    return this.adminService.unmapDid(didId);
  }

  @Post('dids/:didId/remap')
  async remapDid(@Param('didId') didId: string, @Body() dto: { tradieIds: string[] }) {
    return this.adminService.remapDid(didId, dto.tradieIds);
  }
}
