import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CounterDocument = Counter & Document;

@Schema()
export class Counter {
  @Prop({ required: true, unique: true })
  name: string; // e.g. 'companyNo'

  @Prop({ required: true, default: 10000 })
  seq: number;
}

export const CounterSchema = SchemaFactory.createForClass(Counter);
