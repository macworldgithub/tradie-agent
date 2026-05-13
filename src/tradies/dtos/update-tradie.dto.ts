import { PartialType } from '@nestjs/swagger';
import { CreateTradieDto } from './create-tradie.dto';

export class UpdateTradieDto extends PartialType(CreateTradieDto) {}
