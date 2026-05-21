import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type DidDocument = Did & Document;

@Schema({ timestamps: true })
export class Did {
  @Prop({ required: true, unique: true })
  didNumber: string;

  @Prop()
  tradieNumber?: string;

  @Prop({ required: true })
  companyId: string;

  @Prop({ required: true })
  assignedTradieId: string;

  @Prop({ default: true })
  isActive: boolean;
}

export const DidSchema = SchemaFactory.createForClass(Did);
