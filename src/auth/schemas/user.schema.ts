import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type UserDocument = User & Document;

export enum GeoNumberType {
  NEW = 'NEW',
  PORTING = 'PORTING',
  NONE = 'NONE',
}

@Schema({ timestamps: true })
export class User {
  @Prop({ required: true })
  customerName: string;

  @Prop()
  companyName?: string;

  @Prop()
  acn: string;

  @Prop({ required: true, unique: true, lowercase: true })
  email: string;

  @Prop({ required: true })
  password: string;

  @Prop({ required: true })
  trade: string;

  @Prop({ required: true })
  mobileNumber: string;

  @Prop()
  openingHours: string;

  @Prop({ default: false })
  emailVerified: boolean;

  @Prop()
  emailVerificationToken?: string;

  @Prop()
  resetPasswordToken?: string;

  @Prop()
  resetPasswordExpiry?: Date;

  @Prop({ default: false })
  hasPaid: boolean;

  @Prop()
  stripeCustomerId?: string;

  @Prop()
  stripeSubscriptionId?: string;

  @Prop()
  lastPaymentDate?: Date;

  @Prop({ enum: ['AU', 'NZ'] })
  country?: string;

  @Prop()
  cityCode?: string;

  @Prop()
  cityName?: string;


  @Prop()
  phoneNumberInstanceName?: string;

  @Prop()
  phoneNumber?: string;

  @Prop()
  subscriptionExpiresAt?: Date;

  @Prop({ default: false })
  cancelAtPeriodEnd?: boolean;
}

export const UserSchema = SchemaFactory.createForClass(User);
