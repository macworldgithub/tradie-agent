import { PartialType, ApiPropertyOptional } from '@nestjs/swagger';
import { CreateTradieDto } from './create-tradie.dto';
import { IsOptional, IsEnum } from 'class-validator';

export class UpdateTradieDto extends PartialType(CreateTradieDto) {
	@ApiPropertyOptional({ example: 'geo', enum: ['geo', 'ussd'], default: 'geo' })
	@IsOptional()
	@IsEnum(['geo', 'ussd'])
	callMode?: string;
}
