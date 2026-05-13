import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type TradieDocument = Tradie & Document;

@Schema({ timestamps: true })
export class Tradie {
  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  phoneNumber: string;

  @Prop()
  email?: string;

  @Prop({ required: true })
  companyId: string;

  @Prop({ enum: ['email', 'sms', 'both'], default: 'email' })
  notificationPreference: string;

  @Prop({ default: 'active' })
  status: string; // 'active' | 'inactive'
}

export const TradieSchema = SchemaFactory.createForClass(Tradie);
