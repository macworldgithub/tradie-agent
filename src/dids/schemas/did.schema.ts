import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import * as mongoose from 'mongoose';
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

  @Prop({ type: mongoose.Schema.Types.ObjectId, ref: 'Tradie', required: true })
  assignedTradieId: string;
}

export const DidSchema = SchemaFactory.createForClass(Did);
