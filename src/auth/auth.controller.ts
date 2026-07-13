import { Body, Controller, Get, Post, Req, Res, UseGuards, UseInterceptors, UploadedFile, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthService } from './auth.service';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RegisterDto } from './dtos/register.dto';
import { LoginDto } from './dtos/login.dto';
import { ForgotPasswordEmailDto } from './dtos/forgot-password.dto';
import { ChangePasswordDto } from './dtos/change-password.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { VerifyOtpDto } from './dtos/verify-otp.dto';
import { ProfileResponseDto } from './dtos/profile-response.dto';

@ApiTags('Auth')
@Controller('api/auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('register')
  @UseInterceptors(FileInterceptor('supportingDocument'))
  @ApiOperation({ summary: 'Register new user with optional number porting' })
  register(
    @Body() dto: RegisterDto,
    @UploadedFile() file?: Express.Multer.File
  ) {
    return this.authService.register(dto, file);
  }

  @Post('login')
  @ApiOperation({ summary: 'Login user' })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('forgot-password-email')
  @ApiOperation({ summary: 'Generate new password and send via email' })
  async forgotPasswordEmail(@Body() dto: ForgotPasswordEmailDto) {
    return this.authService.forgotPasswordEmail(dto.email);
  }

  @Post('verify-otp')
  @ApiOperation({ summary: 'Verify email using OTP' })
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.authService.verifyOtp(dto.email, dto.otp);
  }

  @Post('change-password')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Change password (requires login)' })
  changePassword(@Req() req, @Body() dto: ChangePasswordDto) {
    return this.authService.changePassword(
      req.user.userId,
      dto.currentPassword,
      dto.newPassword,
    );
  }
  @Get('profile')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get profile information for authenticated user' })
  @ApiResponse({ status: 200, type: ProfileResponseDto })
  getProfile(@Req() req) {
    // We can use req.user.companyId which falls back to req.user.sub (userId)
    return this.authService.getProfile(req.user.companyId);
  }
}
