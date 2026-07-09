import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  OnModuleInit,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { User, UserDocument } from './schemas/user.schema';
import { RegisterDto } from './dtos/register.dto';
import { LoginDto } from './dtos/login.dto';
import { MailService } from '../common/mail/mail.service';
import { generateToken } from './utils/token.util';
import { getCityNameForCode, InvalidCityError } from '../config/au-city-prefixes';
import { Tradie, TradieDocument } from '../tradies/schemas/tradie.schema';

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    @InjectModel(Tradie.name) private tradieModel: Model<TradieDocument>,
    private jwtService: JwtService,
    private configService: ConfigService,
    private mailService: MailService,
  ) { }

  async onModuleInit() {
    await this.seedAdminUser();
  }

  private async seedAdminUser() {
    const adminEmail = this.configService.get<string>('SUPERR_ADMIN_EMAIL');
    if (!adminEmail) return;

    const adminName = this.configService.get<string>('SUPERR_ADMIN_NAME') || 'Lee Atkinson';

    const existingAdmin = await this.userModel.findOne({ email: adminEmail.toLowerCase() });
    if (existingAdmin) {
      if (existingAdmin.customerName !== adminName || existingAdmin.companyName) {
        existingAdmin.customerName = adminName;
        existingAdmin.companyName = undefined;
        await existingAdmin.save();
        this.logger.log(`Updated existing super admin name to: ${adminName}`);
      }
      return;
    }

    this.logger.log(`Seeding initial super admin: ${adminEmail}`);

    const adminPassword = this.configService.get<string>('INITIAL_ADMIN_PASSWORD') || '12344321';
    const hashedPassword = await bcrypt.hash(adminPassword, 10);

    const newAdmin = new this.userModel({
      customerName: adminName,

      email: adminEmail.toLowerCase(),
      password: hashedPassword,
      trade: 'Admin',
      mobileNumber: '0000000000',
      emailVerified: true,
      hasPaid: true,
    });

    await newAdmin.save();
    this.logger.log('Super admin user successfully created.');
  }

  private async signToken(userId: string, email: string) {
    const role = email === this.configService.get<string>('SUPERR_ADMIN_EMAIL') ? 'admin' : 'company';
    const payload = { sub: userId, companyId: userId, email, role };
    return this.jwtService.signAsync(payload, {
      secret: this.configService.get('JWT_ACCESS_SECRET'),
      expiresIn: '7d',
    });
  }

  async register(dto: RegisterDto) {
    const existing = await this.userModel.findOne({
      email: dto.email.toLowerCase(),
    });
    if (existing) throw new BadRequestException('Email already registered');

    let cityName: string;
    try {
      cityName = getCityNameForCode(dto.cityCode);
    } catch (error) {
      if (error instanceof InvalidCityError) {
        throw new BadRequestException('INVALID_CITY');
      }
      throw error;
    }

    const hashedPassword = await bcrypt.hash(dto.password, 10);
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    const newUser = new this.userModel({
      ...dto,
      cityName,
      password: hashedPassword,
      emailVerified: false,
      emailVerificationToken: otp,
    });

    await newUser.save();

    const defaultTradie = new this.tradieModel({
      name: dto.customerName,
      phoneNumber: dto.mobileNumber,
      email: dto.email,
      companyId: newUser._id.toString(),
      notificationPreference: dto.notificationPreference || 'email',
      callReceivedOn: dto.callReceivedOn || 'landline',
      country: dto.country,
    });
    await defaultTradie.save();

    await this.mailService.sendOtpEmail(dto.email, otp);

    return {
      message:
        'User registered successfully. Please verify your email using the OTP sent.',
      userId: newUser._id,
    };
  }

  async login(dto: LoginDto) {
    const user = await this.userModel.findOne({
      email: dto.email.toLowerCase(),
    });
    if (!user) throw new UnauthorizedException('Invalid credentials');

    const valid = await bcrypt.compare(dto.password, user.password);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    if (!user.emailVerified) {
      throw new UnauthorizedException('Email not verified');
    }

    const token = await this.signToken(user._id.toString(), user.email);
    const role = user.email === this.configService.get<string>('SUPERR_ADMIN_EMAIL') ? 'admin' : 'company';

    const userPayload: any = {
      id: user._id,
      email: user.email,
      customerName: user.customerName,
    };

    if (role !== 'admin') {
      userPayload.companyName = user.companyName;
    }

    return {
      accessToken: token,
      user: userPayload,
    };
  }

  async forgotPasswordEmail(email: string) {
    const user = await this.userModel.findOne({ email: email.toLowerCase() });
    if (!user) {
      // For security, don't reveal if user exists
      return { message: 'If the email exists, a new password will be sent.' };
    }

    const newPassword = generateToken().slice(0, 10);
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    user.password = hashedPassword;
    await user.save();

    await this.mailService.sendNewPasswordEmail(user.email, newPassword);

    return { message: 'If the email exists, a new password has been sent.' };
  }

  async verifyOtp(email: string, otp: string) {
    const user = await this.userModel.findOne({
      email: email.toLowerCase(),
      emailVerificationToken: otp,
    });

    if (!user) throw new BadRequestException('Invalid OTP or email');

    user.emailVerified = true;
    user.emailVerificationToken = undefined;
    await user.save();

    return { message: 'Email verified successfully' };
  }

  async changePassword(userId: string, currentPass: string, newPass: string) {
    const user = await this.userModel.findById(userId);
    if (!user) throw new NotFoundException('User not found');

    const valid = await bcrypt.compare(currentPass, user.password);
    if (!valid) throw new UnauthorizedException('Current password incorrect');

    user.password = await bcrypt.hash(newPass, 10);
    await user.save();

    return { message: 'Password changed successfully' };
  }

  async getProfile(userId: string) {
    const user = await this.userModel.findById(userId);
    if (!user) throw new NotFoundException('User not found');

    return {
      customerName: user.customerName,
      companyName: user.companyName,
      acn: user.acn,
      email: user.email,
    };
  }
}
