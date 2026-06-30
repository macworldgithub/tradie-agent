import { PartialType, ApiPropertyOptional } from '@nestjs/swagger';
import { CreateTradieDto } from './create-tradie.dto';
import { IsOptional, IsEnum } from 'class-validator';

export class UpdateTradieDto extends PartialType(CreateTradieDto) {
  @ApiPropertyOptional({
    example: 'landline',
    enum: ['landline', 'mobile'],
    default: 'landline',
  })
  @IsOptional()
  @IsEnum(['landline', 'mobile'])
  callReceivedOn?: string;
}
