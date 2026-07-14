import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MinLength,
  IsEnum,
  IsBoolean,
} from 'class-validator';
import { Transform } from 'class-transformer';
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

  // ─── Porting flag ────────────────────────────────────────────────────
  @ApiProperty({ example: 'true', required: false })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  porting?: boolean;

  // ─── Individual porting detail fields (sent as top-level form fields) ─
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  displayName?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  numberToPort?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  providerName?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  accountNumber?: string;

  @ApiProperty({ required: false, enum: ['Company', 'Business'] })
  @IsOptional()
  @IsString()
  entityType?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  identificationNumber?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  city?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  state?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  postcode?: string;

  /**
   * authorisedContact sent as a JSON string from multipart/form-data.
   * e.g. '{"givenName":"Ayla","familyName":"Imran","contactNumber":"0412457843"}'
   */
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  authorisedContact?: string;

  /** @deprecated Use individual fields above. Kept for backward compatibility. */
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  numberPorting?: string;
}
