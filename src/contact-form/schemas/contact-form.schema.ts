import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ContactFormDocument = ContactForm & Document;

@Schema({ timestamps: true })
export class ContactForm {
  @Prop({ required: true })
  firstName: string;

  @Prop({ required: true })
  lastName: string;

  @Prop({ required: true })
  email: string;

  @Prop({ required: true })
  phoneNumber: string;

  @Prop({ required: false })
  message?: string;
}

export const ContactFormSchema = SchemaFactory.createForClass(ContactForm);
