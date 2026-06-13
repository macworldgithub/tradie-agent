import { ApiProperty } from '@nestjs/swagger';

export class ProfileResponseDto {
  @ApiProperty({ example: 'John Doe' })
  customerName: string;

  @ApiProperty({ example: 'Tradie Co.' })
  companyName: string;

  @ApiProperty({ example: '123 456', required: false })
  acn?: string;

  @ApiProperty({ example: 'john@example.com' })
  email: string;
}
