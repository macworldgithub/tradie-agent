import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_ACCESS_SECRET')!,
    });
  }

  /**
   * Called automatically after JWT is verified.
   * Whatever is returned here is attached to `req.user`.
   */
  async validate(payload: { sub: string; email: string; companyId?: string }) {
    console.log('payload', payload);
    return {
      userId: payload.sub,
      email: payload.email,
      companyId: payload.companyId || payload.sub,
    };
  }
}
