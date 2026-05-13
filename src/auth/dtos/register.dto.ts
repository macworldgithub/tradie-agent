import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MinLength,
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
}
