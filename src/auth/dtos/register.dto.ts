import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MinLength,
  IsEnum,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RegisterDto {
  @ApiProperty({ example: 'John Doe' })
  @IsNotEmpty()
  @IsString()
  customerName: string;

  @ApiProperty({ example: 'Tradie Co.' })
  @IsNotEmpty()
  @IsString()
  companyName: string;

  @ApiProperty({ example: '123 456' })
  @IsOptional()
  @IsString()
  acn?: string;

  @ApiProperty({ example: 'john@example.com' })
  @IsNotEmpty()
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'password123' })
  @IsNotEmpty()
  @MinLength(8)
  password: string;

  @ApiProperty({ example: 'Plumber' })
  @IsNotEmpty()
  @IsString()
  trade: string;

  @ApiProperty({ example: '0412345678' })
  @IsNotEmpty()
  @IsString()
  mobileNumber: string;

  @ApiProperty({ example: '9am-5pm MON-FRI', required: false })
  @IsOptional()
  @IsString()
  openingHours?: string;

  @ApiProperty({ example: 'AU', enum: ['AU', 'NZ'] })
  @IsNotEmpty()
  @IsEnum(['AU', 'NZ'])
  country: string;

  @ApiProperty({ example: 'both', enum: ['email', 'sms', 'both'] })
  @IsNotEmpty()
  @IsEnum(['email', 'sms', 'both'])
  notificationPreference: string;

  @ApiProperty({ example: 'landline', enum: ['landline', 'mobile'] })
  @IsNotEmpty()
  @IsEnum(['landline', 'mobile'])
  callReceivedOn: string;

  @ApiProperty({ example: 'sydney', required: true })
  @IsNotEmpty()
  @IsString()
  cityCode: string;
}
