import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type CallDocument = Call & Document;

export enum CallStatus {
  INCOMING = 'INCOMING',
  DIALING_TRADE = 'DIALING_TRADE',
  CONNECTED_TO_TRADE = 'CONNECTED_TO_TRADE',
  REDIRECTING_TO_AI = 'REDIRECTING_TO_AI',
  CONNECTED_TO_AI = 'CONNECTED_TO_AI',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

export enum CallDirection {
  INBOUND = 'INBOUND',
  OUTBOUND = 'OUTBOUND',
}

@Schema({ timestamps: true })
export class Call {
  @Prop({ required: true, unique: true })
  call_id: string;

  @Prop({ required: true })
  caller_number: string;

  @Prop({ required: true })
  called_number: string;

  @Prop({ required: true, type: Types.ObjectId, ref: 'Tradie' })
  tradie_id: Types.ObjectId;

  @Prop({ enum: CallStatus, default: CallStatus.INCOMING })
  status: CallStatus;

  @Prop({ enum: CallDirection, default: CallDirection.INBOUND })
  direction: CallDirection;

  @Prop()
  start_time: Date;

  @Prop()
  end_time: Date;

  @Prop()
  duration: number;

  @Prop()
  recording_url: string;

  @Prop({ default: false })
  tradie_answered: boolean;

  @Prop({ default: false })
  ai_handled: boolean;

  @Prop()
  notes: string;
}

export const CallSchema = SchemaFactory.createForClass(Call);
