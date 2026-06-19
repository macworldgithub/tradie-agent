import { IsArray, IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RemapAdminDidDto {
  @ApiProperty({ 
    type: [String], 
    example: ['6a34de3b951c116eacb2b793'],
    description: 'Array of tradie IDs to assign to this DID' 
  })
  @IsArray()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  tradieIds: string[];
}
