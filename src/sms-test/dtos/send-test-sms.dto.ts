import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class SendTestSmsDto {
  @ApiProperty({
    example: '+61412345678',
    description: 'Recipient phone number in E.164 format',
  })
  @IsString()
  @IsNotEmpty()
  to: string;

  @ApiProperty({
    example: 'This is a test message',
    description: 'Custom test message body',
  })
  @IsString()
  @IsNotEmpty()
  message: string;
}
