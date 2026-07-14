import { IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateAdminDidDto {
  @ApiProperty({
    example: '+61291234567',
    description: 'The DID phone number to provision',
  })
  @IsString()
  @IsNotEmpty()
  didNumber: string;

  @ApiProperty({
    example: '665f1b2c3d4e5f6a7b8c9d0e',
    description: 'The MongoDB ObjectId of the tradie to assign',
  })
  @IsString()
  @IsNotEmpty()
  tradieId: string;
}
