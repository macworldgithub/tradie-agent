import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type CallLogDocument = CallLog & Document;

@Schema({ timestamps: true })
export class CallLog {
  @Prop({ index: true, sparse: true })
  enfonicaCallId?: string;

  @Prop({ required: true })
  callerNumber: string;

  @Prop({ required: true })
  didNumber: string;

  @Prop()
  tradieNumber?: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Tradie' })
  tradieId?: Types.ObjectId;

  @Prop({ type: [String] })
  tradieIds?: string[];

  @Prop({
    enum: ['initiated', 'no_answer', 'completed'],
    default: 'initiated',
  })
  status: string;

  @Prop({ required: true })
  callStatus: string; // COMPLETED | NOT_ANSWERED | BUSY | FAILED | INITIATED

  @Prop({ default: false })
  fallbackUsed: boolean;

  @Prop({ type: MongooseSchema.Types.Mixed })
  summary?: Record<string, unknown>;
}

export const CallLogSchema = SchemaFactory.createForClass(CallLog);
