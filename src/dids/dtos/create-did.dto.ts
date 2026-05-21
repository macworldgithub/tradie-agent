import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateDidDto {
  @ApiProperty({ example: '+61468112021' })
  @IsString()
  @IsNotEmpty()
  didNumber: string;

  @ApiProperty({ example: '6655f1a2b3c4d5e6f7a8b9c0' })
  @IsString()
  @IsNotEmpty()
  assignedTradieId: string;

  @ApiPropertyOptional({ example: '+61412345678' })
  @IsOptional()
  @IsString()
  tradieNumber?: string;


  @ApiPropertyOptional({ example: true, default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
