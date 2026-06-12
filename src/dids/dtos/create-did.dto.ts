import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateDidDto {
  @ApiProperty({ example: '+61468112021' })
  @IsString()
  @IsNotEmpty()
  didNumber: string;

  @ApiPropertyOptional({ example: '6655f1a2b3c4d5e6f7a8b9c0' })
  @IsString()
  @IsOptional()
  assignedTradieId?: string;

  @ApiPropertyOptional({ example: ['6655f1a2b3c4d5e6f7a8b9c0'] })
  @IsOptional()
  @IsString({ each: true })
  assignedTradieIds?: string[];
}
