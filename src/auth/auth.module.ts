import { Module } from '@nestjs/common';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { User, UserSchema, addCompanyNoHook } from './schemas/user.schema';
import { Counter, CounterSchema } from './schemas/counter.schema';
import { JwtStrategy } from './strategies/jwt.strategy';
import { MailModule } from '../common/mail/mail.module';
import { Tradie, TradieSchema } from '../tradies/schemas/tradie.schema';
import { NumberPortingModule } from '../number-porting/number-porting.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Counter.name, schema: CounterSchema },
      { name: Tradie.name, schema: TradieSchema },
    ]),
    MongooseModule.forFeatureAsync([
      {
        name: User.name,
        imports: [
          MongooseModule.forFeature([
            { name: Counter.name, schema: CounterSchema },
          ]),
        ],
        inject: [getModelToken(Counter.name)],
        useFactory: (counterModel: Model<any>) => {
          const schema = UserSchema;
          addCompanyNoHook(schema, counterModel);
          return schema;
        },
      },
    ]),
    JwtModule.register({}), // config handled manually in service
    MailModule,
    NumberPortingModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
