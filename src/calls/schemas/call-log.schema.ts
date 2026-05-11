import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CallLogDocument = CallLog & Document;

@Schema({ timestamps: true })
export class CallLog {
  @Prop({ required: true })
  callerNumber: string;

  @Prop({ required: true })
  didNumber: string;

  @Prop()
  tradieNumber?: string;

  @Prop({ required: true })
  callStatus: string; // COMPLETED | NOT_ANSWERED | BUSY | FAILED | INITIATED

  @Prop({ default: false })
  fallbackUsed: boolean;
}

export const CallLogSchema = SchemaFactory.createForClass(CallLog);
