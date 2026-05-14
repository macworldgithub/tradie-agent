import { IsOptional, IsString } from 'class-validator';

export class WebhookCallDto {
  @IsOptional()
  @IsString()
  name?: string; // Enfonica call resource name

  @IsOptional()
  @IsString()
  from?: string; // caller number

  @IsOptional()
  @IsString()
  to?: string; // DID number

  @IsOptional()
  @IsString()
  callStatus?: string; // optional, provided on fallback events
}
