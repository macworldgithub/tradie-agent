import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';

export type NumberPortingDocument = NumberPorting & Document;

@Schema()
class AuthorisedContact {
  @Prop({ required: false })
  givenName?: string;

  @Prop({ required: false })
  familyName?: string;

  @Prop({ required: false })
  contactNumber?: string;
}

@Schema({ timestamps: true })
export class NumberPorting {
  @Prop({ type: String, default: uuidv4 })
  _id: string;

  @Prop({ required: true, unique: true })
  companyId: string;

  @Prop({ required: true })
  porting: boolean;

  @Prop({ required: function(this: any) { return this.porting === true; } })
  displayName?: string;

  @Prop({ required: function(this: any) { return this.porting === true; } })
  numberToPort?: string;

  @Prop({ required: function(this: any) { return this.porting === true; } })
  providerName?: string;

  @Prop({ required: function(this: any) { return this.porting === true; } })
  accountNumber?: string;

  @Prop({ enum: ['Company', 'Business'], required: function(this: any) { return this.porting === true; } })
  entityType?: string;

  @Prop({ required: function(this: any) { return this.porting === true; } })
  identificationNumber?: string;

  @Prop({ required: function(this: any) { return this.porting === true; } })
  address?: string;

  @Prop({ required: function(this: any) { return this.porting === true; } })
  city?: string;

  @Prop({ required: function(this: any) { return this.porting === true; } })
  state?: string;

  @Prop({ required: function(this: any) { return this.porting === true; } })
  postcode?: string;

  @Prop({ required: function(this: any) { return this.porting === true; } })
  country?: string;

  @Prop({ required: function(this: any) { return this.porting === true; } })
  supportingDocumentPath?: string;

  @Prop({ type: AuthorisedContact, required: function(this: any) { return this.porting === true; } })
  authorisedContact?: AuthorisedContact;
}

export const NumberPortingSchema = SchemaFactory.createForClass(NumberPorting);
