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

  @ApiPropertyOptional({ 
    example: 'both', 
    enum: ['email', 'sms', 'both'], 
    default: 'email' 
  })
  @IsOptional()
  @IsEnum(['email', 'sms', 'both'])
  notificationPreference?: string;

  @ApiPropertyOptional({
    example: 'landline',
    enum: ['landline', 'mobile'],
    default: 'landline',
  })
  @IsOptional()
  @IsEnum(['landline', 'mobile'])
  callReceivedOn?: string;

  @ApiPropertyOptional({ example: 'AU', enum: ['AU', 'NZ'] })
  @IsOptional()
  @IsEnum(['AU', 'NZ'])
  country?: string;
}
