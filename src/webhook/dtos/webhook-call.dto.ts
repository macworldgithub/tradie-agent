import { IsOptional } from 'class-validator';

export class WebhookCallDto {
  @IsOptional()
  call?: any;

  @IsOptional()
  name?: string;

  @IsOptional()
  from?: string;

  @IsOptional()
  to?: string;

  @IsOptional()
  callStatus?: string;

  @IsOptional()
  state?: string;
}
