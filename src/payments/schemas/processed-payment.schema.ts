import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ProcessedPaymentDocument = ProcessedPayment & Document;

@Schema({ timestamps: true })
export class ProcessedPayment {
  @Prop({ required: true, unique: true })
  stripeId: string; // Checkout Session ID, Invoice ID, or Subscription Period ID

  @Prop({ required: true })
  companyId: string;

  @Prop({ required: true })
  eventType: string; // e.g. 'checkout.session.completed', 'invoice.paid', or 'subscription.sync'
}

export const ProcessedPaymentSchema = SchemaFactory.createForClass(ProcessedPayment);
