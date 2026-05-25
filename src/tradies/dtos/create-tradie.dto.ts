import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, IsEnum } from 'class-validator';

export class CreateTradieDto {
  @ApiProperty({ example: 'John Smith' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: '+61412345678' })
  @IsString()
  @IsNotEmpty()
  phoneNumber: string;

  @ApiPropertyOptional({ example: 'john@example.com' })
  @IsOptional()
  @IsString()
  email?: string;

  @ApiPropertyOptional({ example: 'email', default: 'email' })
  @IsOptional()
  @IsString()
  notificationPreference?: string;

  @ApiPropertyOptional({
    example: 'geo',
    enum: ['geo', 'ussd'],
    default: 'geo',
  })
  @IsOptional()
  @IsEnum(['geo', 'ussd'])
  callMode?: string;
}
